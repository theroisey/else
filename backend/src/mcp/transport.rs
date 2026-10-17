//! Single-listener, JSON-response Streamable HTTP. No SSE/subscription promise.
use super::{access, oauth, protocol};
use crate::{
    api::{Api, Request},
    error::{Error, Result},
    query::Query,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use http::{HeaderValue, Method, Response, header};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

pub struct Bridge {
    admission: Semaphore,
    rates: Mutex<BTreeMap<String, (Instant, u16)>>,
}
impl Default for Bridge {
    fn default() -> Self {
        Self {
            admission: Semaphore::new(12),
            rates: Mutex::new(BTreeMap::new()),
        }
    }
}
impl Bridge {
    pub fn admit(&self) -> Result<tokio::sync::SemaphorePermit<'_>> {
        self.admission.try_acquire().map_err(|_| Error::Busy)
    }
    fn rate(&self, peer: &str, token: bool) -> Result<()> {
        let mut rates = self.rates.lock().map_err(|_| Error::Internal)?;
        let key = format!("{}:{peer}", if token { "oauth" } else { "mcp" });
        let now = Instant::now();
        if rates.len() >= 4096 {
            rates.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(60));
            if rates.len() >= 4096 && !rates.contains_key(&key) {
                return Err(Error::Busy);
            }
        }
        let entry = rates.entry(key).or_insert((now, 0));
        if now.duration_since(entry.0) >= Duration::from_secs(60) {
            *entry = (now, 0)
        }
        let limit = if token { 60 } else { 2400 };
        if entry.1 >= limit {
            return Err(Error::Response(
                http::StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Request rate exceeded.",
            ));
        }
        entry.1 += 1;
        Ok(())
    }
    pub async fn handle(&self, api: &Api, r: Request) -> Response<Bytes> {
        let mut observation = super::metrics::http();
        let result = match self
            .rate(&r.peer, r.path.starts_with("/oauth/"))
            .and_then(|_| host(api, &r))
        {
            Ok(()) => self.inner(api, &r).await,
            Err(e) => Err(e),
        };
        let mut response = match result {
            Ok(v) => v,
            Err(e) => failure(api, &r, &e),
        };
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, private"),
        );
        response
            .headers_mut()
            .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
        if let Some(origin) = r.headers.get(header::ORIGIN)
            && origin_allowed(api, &r).await.unwrap_or(false)
        {
            response
                .headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
            response
                .headers_mut()
                .insert(header::VARY, HeaderValue::from_static("Origin"));
            response.headers_mut().insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static("WWW-Authenticate, MCP-Protocol-Version, X-Request-Id"),
            );
        }
        if response.status().is_success() || response.status().is_redirection() {
            observation.success();
        }
        response
    }
    async fn inner(&self, api: &Api, r: &Request) -> Result<Response<Bytes>> {
        if r.query_present && r.path != "/oauth/authorize" {
            return Err(Error::Invalid("invalid_request"));
        }
        if !origin_allowed(api, r).await? {
            return Err(Error::Denied);
        }
        if r.method == Method::OPTIONS
            && matches!(r.path.as_str(), "/oauth/token" | "/oauth/revoke")
        {
            if !r.body.is_empty() {
                return Err(Error::Invalid("invalid_request"));
            }
            let mut out = response(204, Value::Null)?;
            out.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("POST, OPTIONS"),
            );
            out.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("Content-Type"),
            );
            return Ok(out);
        }
        match r.path.as_str() {
            "/.well-known/oauth-protected-resource/mcp"
            | "/.well-known/oauth-protected-resource" => {
                get(r)?;
                response(200, oauth::resource_metadata(&api.config))
            }
            "/.well-known/oauth-authorization-server" => {
                get(r)?;
                response(200, oauth::server_metadata(&api.config))
            }
            "/oauth/authorize" => {
                if r.method != Method::GET || !r.body.is_empty() {
                    return Err(Error::Method("GET"));
                }
                let q = Query::parse(
                    &r.query,
                    &[
                        "response_type",
                        "client_id",
                        "redirect_uri",
                        "resource",
                        "scope",
                        "state",
                        "code_challenge",
                        "code_challenge_method",
                    ],
                )?;
                let location = oauth::start(&api.db, &api.config, q).await?;
                let mut out = response(302, json!({}))?;
                out.headers_mut().insert(
                    header::LOCATION,
                    HeaderValue::from_str(&location).map_err(|_| Error::Internal)?,
                );
                Ok(out)
            }
            "/oauth/token" | "/oauth/revoke" => {
                if r.method != Method::POST {
                    return Err(Error::Method("POST"));
                }
                content_type(r, "application/x-www-form-urlencoded")?;
                let body =
                    std::str::from_utf8(&r.body).map_err(|_| Error::Invalid("invalid_request"))?;
                if let Some(origin) = one(r, "origin")?
                    && origin != api.config.origin
                {
                    let parameters = Query::parse(
                        body,
                        &[
                            "grant_type",
                            "client_id",
                            "resource",
                            "redirect_uri",
                            "code",
                            "code_verifier",
                            "refresh_token",
                            "scope",
                            "token",
                            "token_type_hint",
                        ],
                    )?;
                    let app = parameters
                        .get("client_id")
                        .ok_or(Error::Invalid("invalid_client"))?
                        .to_owned();
                    let origin = origin.to_owned();
                    let registered = api.db.read(move |tx| Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_origins o JOIN mcp_applications a ON a.id=o.application_id WHERE o.application_id=?1 AND o.origin=?2 AND a.revoked_at IS NULL)", rusqlite::params![app, origin], |row| row.get::<_, bool>(0))?)).await?;
                    if !registered {
                        return Err(Error::Denied);
                    }
                }
                if r.path == "/oauth/revoke" {
                    oauth::revoke(
                        &api.db,
                        Query::parse(body, &["client_id", "token", "token_type_hint"])?,
                    )
                    .await?;
                    response(200, json!({}))
                } else {
                    let q = Query::parse(
                        body,
                        &[
                            "grant_type",
                            "client_id",
                            "resource",
                            "redirect_uri",
                            "code",
                            "code_verifier",
                            "refresh_token",
                            "scope",
                        ],
                    )?;
                    match oauth::token(&api.db, &api.config, q).await {
                        Ok(v) => response(200, v),
                        Err(e) => {
                            let code = match e.code() {
                                "invalid_scope" => "invalid_scope",
                                "invalid_client" => "invalid_client",
                                "invalid_target" => "invalid_target",
                                "unsupported_grant_type" => "unsupported_grant_type",
                                "invalid_request" => "invalid_request",
                                _ => {
                                    if matches!(e, Error::Busy | Error::Internal) {
                                        "temporarily_unavailable"
                                    } else {
                                        "invalid_grant"
                                    }
                                }
                            };
                            response(
                                if code == "temporarily_unavailable" {
                                    503
                                } else {
                                    400
                                },
                                json!({"error":code}),
                            )
                        }
                    }
                }
            }
            "/mcp" => self.rpc(api, r).await,
            _ => Err(Error::NotFound),
        }
    }
    async fn rpc(&self, api: &Api, r: &Request) -> Result<Response<Bytes>> {
        if r.method == Method::OPTIONS {
            if !r.body.is_empty() {
                return Err(Error::Invalid("invalid_request"));
            }
            let mut out = response(204, Value::Null)?;
            out.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("POST, OPTIONS"),
            );
            out.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_HEADERS,HeaderValue::from_static("Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name"));
            return Ok(out);
        }
        if r.method != Method::POST {
            return Err(Error::Method("POST, OPTIONS"));
        }
        let bearer = one(r, "authorization")?
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(Error::Unauthorized)?;
        let actor = access::authenticate(
            &api.db,
            bearer,
            oauth::resource(&api.config),
            r.request_id.clone(),
        )
        .await?;
        if let Some(origin) = one(r, "origin")?
            && origin != api.config.origin
        {
            let app = actor
                .delegation()
                .ok_or(Error::Denied)?
                .application_id
                .clone();
            let origin = origin.to_owned();
            let yes=api.db.read(move|tx|Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_origins WHERE application_id=?1 AND origin=?2)",rusqlite::params![app,origin],|r|r.get::<_,bool>(0))?)).await?;
            if !yes {
                return Err(Error::Denied);
            }
        }
        content_type(r, "application/json")?;
        if !accepts(r, "application/json") || !accepts(r, "text/event-stream") {
            return response(
                406,
                protocol::error(
                    None,
                    -32600,
                    "Accept must include application/json and text/event-stream.",
                    None,
                ),
            );
        }
        let raw = match crate::provider_json::parse_protocol(&r.body) {
            Ok(v) => v,
            Err(_) => return response(400, protocol::error(None, -32700, "Parse error.", None)),
        };
        let e = match protocol::parse(&raw) {
            Ok(v) => v,
            Err(_) => {
                return response(400, protocol::error(None, -32600, "Invalid request.", None));
            }
        };
        let header = one(r, "mcp-protocol-version")?;
        let body_version =
            raw["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"].as_str();
        let requested = if e.method == "initialize" && header.is_none() && body_version.is_none() {
            Some(protocol::LEGACY)
        } else {
            header.or(body_version).or_else(|| {
                if e.method == "initialize" {
                    raw["params"]["protocolVersion"].as_str()
                } else {
                    None
                }
            })
        };
        let version = match requested {
            Some(protocol::MODERN) => protocol::MODERN,
            Some(protocol::LEGACY) => protocol::LEGACY,
            _ => {
                return response(
                    400,
                    protocol::error(
                        e.id,
                        -32022,
                        "Unsupported protocol version.",
                        Some(
                            json!({"supported":[protocol::MODERN,protocol::LEGACY],"requested":requested}),
                        ),
                    ),
                );
            }
        };
        if version == protocol::MODERN {
            let meta = raw["params"]["_meta"].as_object();
            if header != Some(protocol::MODERN)
                || body_version != Some(protocol::MODERN)
                || meta
                    .and_then(|m| m.get("io.modelcontextprotocol/clientCapabilities"))
                    .is_none_or(|v| !v.is_object())
            {
                return response(
                    400,
                    protocol::error(
                        e.id,
                        -32020,
                        "Protocol metadata and headers must match.",
                        None,
                    ),
                );
            }
            let caps = meta
                .and_then(|m| m.get("io.modelcontextprotocol/clientCapabilities"))
                .ok_or(Error::Invalid("invalid_params"))?;
            let valid_caps =
                serde_json::from_value::<rmcp::model::ClientCapabilities>(caps.clone()).is_ok();
            let valid_info = meta
                .and_then(|m| m.get("io.modelcontextprotocol/clientInfo"))
                .is_none_or(|info| {
                    serde_json::from_value::<rmcp::model::Implementation>(info.clone()).is_ok()
                });
            if !valid_caps || !valid_info {
                return response(
                    400,
                    protocol::error(e.id, -32602, "Invalid client metadata.", None),
                );
            }
            if named_header(r, "mcp-method").ok().flatten().as_deref() != Some(&e.method) {
                return response(
                    400,
                    protocol::error(e.id, -32020, "Mcp-Method does not match the request.", None),
                );
            }
            let name = match e.method.as_str() {
                "tools/call" | "prompts/get" => Some(
                    raw["params"]["name"]
                        .as_str()
                        .ok_or(Error::Invalid("invalid_params"))?,
                ),
                "resources/read" => Some(
                    raw["params"]["uri"]
                        .as_str()
                        .ok_or(Error::Invalid("invalid_params"))?,
                ),
                _ => None,
            };
            if let Some(name) = name
                && named_header(r, "mcp-name").ok().flatten().as_deref() != Some(name)
            {
                return response(
                    400,
                    protocol::error(e.id, -32020, "Mcp-Name does not match the request.", None),
                );
            }
        } else if (header.is_none() && e.method != "initialize")
            || body_version.is_some_and(|v| v != version)
        {
            return response(
                400,
                protocol::error(
                    e.id,
                    -32020,
                    "Protocol metadata and headers must match.",
                    None,
                ),
            );
        }
        if e.id.is_none() {
            if e.method.starts_with("notifications/") {
                // No cross-request cancellation authority is inferred from an ID.
                // Disconnected/aborted writes reconcile through durable commands.
                return response(202, Value::Null);
            }
            return response(
                400,
                protocol::error(None, -32600, "Request ID is required.", None),
            );
        }
        let named_tool = match e.method.as_str() {
            "tools/call" => e.params["name"].as_str(),
            "resources/read" => e.params["uri"].as_str().and_then(|uri| {
                super::context::resource_tool(uri)
                    .ok()
                    .map(|(name, _)| name)
            }),
            "prompts/get" => e.params["name"]
                .as_str()
                .and_then(super::context::prompt_tool),
            _ => None,
        };
        if let Some(definition) = named_tool.and_then(|name| {
            super::registry::definitions()
                .iter()
                .find(|d| d.name == name)
        }) && !definition.scope.is_empty()
            && actor
                .delegation()
                .is_some_and(|d| !d.scopes.contains(definition.scope))
        {
            let mut out = response(
                403,
                protocol::error(
                    e.id.clone(),
                    -32001,
                    "An additional delegated scope is required.",
                    Some(json!({"reason":"insufficient_scope","scope":definition.scope})),
                ),
            )?;
            let challenge = format!(
                "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\", error=\"insufficient_scope\", scope=\"{}\"",
                api.config.origin, definition.scope
            );
            out.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_str(&challenge).map_err(|_| Error::Internal)?,
            );
            return Ok(out);
        }
        let id = e.id.clone();
        let data = match protocol::dispatch(api, actor, &e).await {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(error) => {
                let (status, code) = match error {
                    Error::NotFound => (
                        if e.modern { 404 } else { 200 },
                        if e.method == "resources/read" {
                            -32002
                        } else {
                            -32601
                        },
                    ),
                    Error::Invalid(_) => (200, -32602),
                    Error::Denied => (403, -32001),
                    Error::Unauthorized => (401, -32001),
                    Error::Busy => (503, -32603),
                    _ => (500, -32603),
                };
                return response(
                    status,
                    protocol::error(
                        id,
                        code,
                        error.message(),
                        Some(json!({"reason":error.code()})),
                    ),
                );
            }
        };
        let mut out = response(200, data)?;
        out.headers_mut()
            .insert("mcp-protocol-version", HeaderValue::from_static(version));
        Ok(out)
    }
}
fn get(r: &Request) -> Result<()> {
    if r.method != Method::GET {
        return Err(Error::Method("GET"));
    }
    if !r.body.is_empty() {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(())
}
fn one<'a>(r: &'a Request, name: &str) -> Result<Option<&'a str>> {
    let mut all = r.headers.get_all(name).iter();
    let first = all.next();
    if all.next().is_some() {
        return Err(Error::Invalid("invalid_request"));
    }
    first
        .map(|v| v.to_str().map_err(|_| Error::Invalid("invalid_request")))
        .transpose()
}
fn content_type(r: &Request, kind: &str) -> Result<()> {
    let value = one(r, "content-type")?.ok_or(Error::Invalid("invalid_request"))?;
    if !value
        .split(';')
        .next()
        .is_some_and(|v| v.trim().eq_ignore_ascii_case(kind))
    {
        return Err(Error::Response(
            http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "invalid_request",
            "Unsupported content type.",
        ));
    }
    Ok(())
}
fn accepts(r: &Request, kind: &str) -> bool {
    r.headers
        .get_all(header::ACCEPT)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(','))
        .any(|s| {
            let mut parts = s.split(';');
            parts
                .next()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case(kind))
                && !parts.any(|p| {
                    p.trim()
                        .strip_prefix("q=")
                        .is_some_and(|q| q.parse::<f32>().ok() == Some(0.0))
                })
        })
}
fn named_header(r: &Request, key: &str) -> Result<Option<String>> {
    one(r, key)?
        .map(|raw| {
            if let Some(encoded) = raw
                .strip_prefix("=?base64?")
                .and_then(|v| v.strip_suffix("?="))
            {
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| Error::Invalid("header_mismatch"))?;
                if STANDARD.encode(&bytes) != encoded {
                    return Err(Error::Invalid("header_mismatch"));
                }
                String::from_utf8(bytes).map_err(|_| Error::Invalid("header_mismatch"))
            } else {
                Ok(raw.to_owned())
            }
        })
        .transpose()
}
fn host(api: &Api, r: &Request) -> Result<()> {
    let origin = url::Url::parse(&api.config.origin).map_err(|_| Error::Internal)?;
    let expected = &origin[url::Position::BeforeHost..url::Position::AfterPort];
    if one(r, "host")?.is_none_or(|h| !h.eq_ignore_ascii_case(expected)) {
        return Err(Error::Denied);
    }
    Ok(())
}
async fn origin_allowed(api: &Api, r: &Request) -> Result<bool> {
    let Some(origin) = one(r, "origin")? else {
        return Ok(true);
    };
    if origin == api.config.origin {
        return Ok(true);
    }
    if matches!(
        r.path.as_str(),
        "/.well-known/oauth-protected-resource/mcp"
            | "/.well-known/oauth-protected-resource"
            | "/.well-known/oauth-authorization-server"
    ) {
        let url = url::Url::parse(origin).map_err(|_| Error::Denied)?;
        return Ok(url.origin().ascii_serialization() == origin
            && matches!(url.scheme(), "http" | "https"));
    }
    if !matches!(r.path.as_str(), "/mcp" | "/oauth/token" | "/oauth/revoke") {
        return Ok(false);
    }
    let origin = origin.to_owned();
    api.db.read(move|tx|Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_origins o JOIN mcp_applications a ON a.id=o.application_id WHERE o.origin=?1 AND a.revoked_at IS NULL)",[origin],|r|r.get::<_,bool>(0))?)).await
}
pub fn response(status: u16, value: Value) -> Result<Response<Bytes>> {
    let raw = if value.is_null() {
        vec![]
    } else {
        serde_json::to_vec(&value).map_err(|_| Error::Internal)?
    };
    if raw.len() > protocol::MAX_RESPONSE {
        return response(
            413,
            protocol::error(
                value.get("id").cloned(),
                -32603,
                "Result exceeds the response budget. Narrow the query.",
                None,
            ),
        );
    }
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store, private")
        .body(Bytes::from(raw))
        .map_err(|_| Error::Internal)
}
pub fn failure(api: &Api, r: &Request, error: &Error) -> Response<Bytes> {
    let value = if r.path == "/mcp" {
        protocol::error(
            None,
            -32600,
            error.message(),
            Some(json!({"reason":error.code()})),
        )
    } else {
        json!({"error":if matches!(error,Error::Denied){"access_denied"}else{"invalid_request"}})
    };
    let mut out = response(error.status().as_u16(), value).expect("fixed bounded error");
    if matches!(error, Error::Unauthorized | Error::Denied) && r.path == "/mcp" {
        let challenge = format!(
            "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\", scope=\"clients:read\", error=\"{}\"",
            api.config.origin,
            if matches!(error, Error::Unauthorized) {
                "invalid_token"
            } else {
                "insufficient_scope"
            }
        );
        if let Ok(v) = HeaderValue::from_str(&challenge) {
            out.headers_mut().insert(header::WWW_AUTHENTICATE, v);
        }
    }
    if let Error::Method(allowed) = error {
        out.headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static(allowed));
    }
    if error.status() == http::StatusCode::TOO_MANY_REQUESTS {
        out.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
    }
    if matches!(error, Error::Busy) {
        out.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    }
    out
}
