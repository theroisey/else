use crate::{
    api::{Api, Reply, Request},
    audit,
    error::{Error, Result},
    static_files::{Assets, accepts_gzip},
};
use async_trait::async_trait;
use bytes::Bytes;
use http::{HeaderValue, Method, Response, StatusCode, header};
use pingora_core::{
    apps::{HttpPersistentSettings, HttpServerApp, HttpServerOptions, ReusedHttpStream},
    protocols::http::ServerSession,
    server::ShutdownWatch,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

pub struct Application {
    pub api: Api,
    pub assets: Assets,
    pub draining: Arc<AtomicBool>,
    requests: Semaphore,
    options: HttpServerOptions,
}

impl Application {
    pub fn new(api: Api, assets: Assets, draining: Arc<AtomicBool>) -> Self {
        let mut options = HttpServerOptions::default();
        options.keepalive_request_limit = Some(1000);
        options.h2_idle_timeout = Some(Duration::from_secs(60));
        Self {
            api,
            assets,
            draining,
            requests: Semaphore::new(128),
            options,
        }
    }

    async fn handle(
        &self,
        session: &mut ServerSession,
        correlation: &str,
    ) -> Result<Response<Bytes>> {
        let _permit = self.requests.try_acquire().map_err(|_| Error::Busy)?;
        if self.draining.load(Ordering::Acquire) {
            return Err(Error::Busy);
        }
        let req = session.req_header();
        let header_size = req
            .headers
            .iter()
            .map(|(name, value)| name.as_str().len() + value.len() + 4)
            .sum::<usize>()
            + req.uri.to_string().len();
        if header_size > 16 * 1024 {
            return Err(Error::Response(
                StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
                "invalid_request",
                "Request headers exceed the allowed size.",
            ));
        }
        let method = req.method.clone();
        let path = req.uri.path().to_owned();
        let query = req.uri.query().unwrap_or("").to_owned();
        let headers = req.headers.clone();
        if path.contains(['%', '\\', '\0'])
            || path.contains("//")
            || path.split('/').any(|p| matches!(p, "." | ".."))
        {
            return Err(Error::NotFound);
        }
        let peer = session
            .client_addr()
            .and_then(|a| a.as_inet())
            .map(|a| a.ip().to_string())
            .unwrap_or_else(|| "unknown".into());
        let mut body = Vec::new();
        while let Some(chunk) = session
            .read_request_body()
            .await
            .map_err(|_| Error::Invalid("invalid_request"))?
        {
            if body.len() + chunk.len() > 64 * 1024 {
                return Err(Error::Invalid("invalid_request"));
            }
            body.extend_from_slice(&chunk);
        }
        if matches!(path.as_str(), "/health" | "/ready" | "/status") {
            if !matches!(method, Method::GET | Method::HEAD) {
                return Err(Error::Method("GET, HEAD"));
            }
            if !query.is_empty() || !body.is_empty() {
                return Err(Error::Invalid("invalid_request"));
            }
            if path == "/ready" {
                self.api.db.ready().await.map_err(|_| {
                    Error::Response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "not_ready",
                        "Service is not ready.",
                    )
                })?;
            }
            let reply = Reply {
                status: 200,
                body: Some(serde_json::json!({"status":if path=="/ready"{"ready"}else{"ok"}})),
                cookies: vec![],
            };
            return json_response(reply, &method);
        }
        if path == "/api" || path.starts_with("/api/") {
            return json_response(
                self.api
                    .dispatch(Request {
                        method: method.clone(),
                        path,
                        query_present: session.req_header().uri.query().is_some(),
                        query,
                        headers,
                        body,
                        peer,
                        request_id: correlation.into(),
                    })
                    .await?,
                &method,
            );
        }
        if !matches!(method, Method::GET | Method::HEAD) {
            return Err(Error::Method("GET, HEAD"));
        }
        if !body.is_empty() {
            return Err(Error::Invalid("invalid_request"));
        }
        let asset = self.assets.get(&path)?;
        let gzip = headers
            .get(header::ACCEPT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .is_some_and(accepts_gzip)
            && asset.gzip.is_some();
        let etag = if gzip {
            format!("W/{}", asset.etag)
        } else {
            asset.etag.clone()
        };
        let not_modified = headers
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(',')
                    .any(|tag| tag.trim() == etag || tag.trim() == "*")
            });
        let content = if gzip {
            asset.gzip.as_ref().ok_or(Error::Internal)?
        } else {
            &asset.body
        };
        let mut response = Response::builder()
            .status(if not_modified { 304 } else { 200 })
            .header(header::CONTENT_TYPE, asset.content_type)
            .header(
                header::CACHE_CONTROL,
                if asset.immutable {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                },
            )
            .header(header::ETAG, etag)
            .header(header::VARY, "Accept-Encoding");
        if gzip {
            response = response.header(header::CONTENT_ENCODING, "gzip");
        }
        if !not_modified {
            response = response.header(header::CONTENT_LENGTH, content.len());
        }
        response
            .body(if method == Method::HEAD || not_modified {
                Bytes::new()
            } else {
                content.clone()
            })
            .map_err(|_| Error::Internal)
    }

    fn failure(&self, error: &Error, method: &Method, correlation: &str) -> Response<Bytes> {
        let mut response=json_response(Reply {status:error.status().as_u16(),body:Some(serde_json::json!({"error":{"code":error.code(),"message":error.message(),"request_id":correlation}})),cookies:if matches!(error,Error::Unauthorized){self.api.clear_cookies()}else{vec![]}},method).expect("fixed error response");
        if let Error::Method(allowed) = error {
            response
                .headers_mut()
                .insert(header::ALLOW, HeaderValue::from_static(allowed));
        }
        if error.status() == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("900"));
        } else if error.status() == StatusCode::SERVICE_UNAVAILABLE {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        }
        response
    }
}

#[async_trait]
impl HttpServerApp for Application {
    async fn process_new_http(
        self: &Arc<Self>,
        mut session: ServerSession,
        shutdown: &ShutdownWatch,
    ) -> Option<ReusedHttpStream> {
        session.set_read_timeout(Some(Duration::from_secs(5)));
        session.set_write_timeout(Some(Duration::from_secs(15)));
        if !session.read_request().await.ok()? {
            return None;
        }
        session.set_keepalive(
            if *shutdown.borrow() || self.draining.load(Ordering::Acquire) {
                None
            } else {
                Some(60)
            },
        );
        let started = Instant::now();
        let correlation = audit::request_id();
        let method = session.req_header().method.clone();
        let probe = matches!(
            session.req_header().uri.path(),
            "/health" | "/ready" | "/status"
        );
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            self.handle(&mut session, &correlation),
        )
        .await
        .unwrap_or_else(|_| {
            Err(Error::Response(
                StatusCode::SERVICE_UNAVAILABLE,
                "request_timeout",
                "The request timed out. Refresh before retrying.",
            ))
        });
        let mut response = match result {
            Ok(response) => response,
            Err(error) => {
                // No header dumps, raw URLs, query strings, body values or driver errors.
                tracing::warn!(request_id=%correlation,error_code=error.code(),status=error.status().as_u16(),"request_rejected");
                session.set_keepalive(None);
                self.failure(&error, &method, &correlation)
            }
        };
        response.headers_mut().insert(
            "x-request-id",
            HeaderValue::from_str(&correlation).expect("server request ID"),
        );
        browser_headers(response.headers_mut());
        if !probe {
            tracing::info!(request_id=%correlation,status=response.status().as_u16(),duration_ms=started.elapsed().as_millis() as u64,"request_completed");
        }
        let (parts, body) = response.into_parts();
        session
            .write_response_header(Box::new(parts.into()))
            .await
            .ok()?;
        if !body.is_empty() {
            session.write_response_body(body, true).await.ok()?;
        }
        let settings = HttpPersistentSettings::for_session(&session);
        session
            .finish()
            .await
            .ok()?
            .map(|stream| ReusedHttpStream::from_reusable_stream(stream, settings))
    }

    fn server_options(&self) -> Option<&HttpServerOptions> {
        Some(&self.options)
    }
}

fn json_response(reply: Reply, method: &Method) -> Result<Response<Bytes>> {
    let body = reply
        .body
        .map(|body| serde_json::to_vec(&body).map(Bytes::from))
        .transpose()
        .map_err(|_| Error::Internal)?
        .unwrap_or_default();
    let mut response = Response::builder()
        .status(reply.status)
        .header(header::CACHE_CONTROL, "no-store");
    if reply.status != 204 {
        response = response
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header(header::CONTENT_LENGTH, body.len());
    }
    for cookie in reply.cookies {
        response = response.header(header::SET_COOKIE, cookie);
    }
    response
        .body(if method == Method::HEAD {
            Bytes::new()
        } else {
            body
        })
        .map_err(|_| Error::Internal)
}

fn browser_headers(headers: &mut http::HeaderMap) {
    for (key, value) in [
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        ),
        ("x-frame-options", "DENY"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
    ] {
        headers.insert(key, HeaderValue::from_static(value));
    }
}
