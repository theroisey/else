use crate::{
    activity, administration, audit_reader,
    auth::{Auth, Login},
    billing, clients,
    config::Config,
    db::Database,
    error::{Error, Result},
    integrations, overview, planning, pricing,
    query::Query,
    reminders,
    security::Actor,
    tasks, validation, websites,
};
use http::{HeaderMap, Method, StatusCode};
use serde::Deserialize;
use serde_json::Value;

pub struct Request {
    pub method: Method,
    pub path: String,
    pub query: String,
    pub query_present: bool,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    pub peer: String,
    pub request_id: String,
}
pub struct Reply {
    pub status: u16,
    pub body: Option<Value>,
    pub cookies: Vec<String>,
}

impl Reply {
    pub fn data<T: serde::Serialize>(status: u16, data: T) -> Result<Self> {
        Ok(Self {
            status,
            body: Some(
                serde_json::json!({"data":serde_json::to_value(data).map_err(|_|Error::Internal)?}),
            ),
            cookies: vec![],
        })
    }
    pub fn page(data: Value) -> Self {
        Self {
            status: 200,
            body: Some(data),
            cookies: vec![],
        }
    }
    pub fn empty() -> Self {
        Self {
            status: 204,
            body: None,
            cookies: vec![],
        }
    }
}

pub struct Api {
    pub config: Config,
    pub db: Database,
    pub auth: Auth,
    pub vault: crate::vault::Vault,
    pub synchronization: crate::synchronization::Synchronization,
    pub report_cache: crate::cache::ReportCache,
}

mod billing_routes;
mod integration_routes;
mod planning_routes;
mod pricing_routes;
mod reminders_routes;
mod report_routes;
mod tasks_routes;
mod website_routes;

impl Api {
    pub async fn dispatch(&self, request: Request) -> Result<Reply> {
        let parts: Vec<&str> = request.path.trim_start_matches('/').split('/').collect();
        if parts.len() < 3
            || parts[0] != "api"
            || parts[1] != "v1"
            || parts.iter().any(|p| p.is_empty())
        {
            return Err(Error::NotFound);
        }
        let route = &parts[2..];
        if ![
            "auth",
            "users",
            "roles",
            "permissions",
            "clients",
            "audit-logs",
        ]
        .contains(&route[0])
        {
            return Err(Error::NotFound);
        }
        let method = request.method.as_str();
        let mutating = matches!(method, "POST" | "PUT" | "PATCH" | "DELETE");
        if mutating {
            self.unsafe_request(&request)?;
        }
        if route == ["auth", "login"] {
            no_query(&request)?;
            if method != "POST" {
                return Err(Error::Method("POST"));
            }
            if request.body.len() > 4096 {
                return Err(Error::Invalid("invalid_request"));
            }
            let input: Login = validation::json(&request.body)?;
            self.auth.limit(&request.peer, &input.email)?;
            let login = self.auth.login(input, request.request_id.clone()).await?;
            return Ok(Reply {
                status: 200,
                body: Some(login.session.document()),
                cookies: self.login_cookies(&login.token, &login.csrf, &login.session.expires_at),
            });
        }
        let token =
            cookie(&request.headers, self.config.session_cookie()).ok_or(Error::Unauthorized)?;
        let session = self
            .auth
            .current(&token, request.request_id.clone())
            .await?;
        let actor = session.actor;
        if mutating {
            let csrf =
                cookie(&request.headers, self.config.csrf_cookie()).ok_or_else(csrf_error)?;
            let header = single_header(&request.headers, "x-csrf-token").ok_or_else(csrf_error)?;
            if !Auth::csrf(&actor, &csrf, header) {
                return Err(csrf_error());
            }
        }
        match route {
            ["audit-logs"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                if request.query.len() > 2048 {
                    return Err(Error::Invalid("invalid_request"));
                }
                Ok(Reply::page(
                    audit_reader::list(
                        &self.db,
                        actor,
                        None,
                        query(&request, audit_reader::FILTERS)?,
                    )
                    .await?,
                ))
            }
            ["audit-logs", event] => {
                no_query(&request)?;
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    audit_reader::read(&self.db, actor, None, validation::id(event)?).await?,
                )
            }
            ["clients", client, "audit-logs"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                if request.query.len() > 2048 {
                    return Err(Error::Invalid("invalid_request"));
                }
                Ok(Reply::page(
                    audit_reader::list(
                        &self.db,
                        actor,
                        Some(validation::id(client)?),
                        query(&request, audit_reader::FILTERS)?,
                    )
                    .await?,
                ))
            }
            ["clients", client, "audit-logs", event] => {
                no_query(&request)?;
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    audit_reader::read(
                        &self.db,
                        actor,
                        Some(validation::id(client)?),
                        validation::id(event)?,
                    )
                    .await?,
                )
            }
            ["clients", client, "activity"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    activity::list(
                        &self.db,
                        actor,
                        validation::id(client)?,
                        query(&request, &["limit", "cursor"])?,
                    )
                    .await?,
                ))
            }
            ["clients", client, "overview"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                if request.query_present {
                    return Err(Error::Invalid("invalid_request"));
                }
                Reply::data(
                    200,
                    overview::read(&self.db, actor, validation::id(client)?).await?,
                )
            }
            ["auth", "session"] => {
                no_query(&request)?;
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    serde_json::json!({"user":session.user,"session":{"expires_at":session.expires_at}}),
                )
            }
            ["auth", "logout"] => {
                no_query(&request)?;
                if method != "POST" {
                    return Err(Error::Method("POST"));
                }
                self.auth.logout(actor).await?;
                let mut reply = Reply::empty();
                reply.cookies = self.clear_cookies();
                Ok(reply)
            }
            ["auth", "preferences"] => {
                no_query(&request)?;
                match method {
                    "GET" => Reply::data(
                        200,
                        serde_json::json!({"locale":self.auth.locale(actor).await?}),
                    ),
                    "PUT" => {
                        #[derive(Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct Input {
                            locale: String,
                        }
                        let input: Input = validation::json(&request.body)?;
                        self.auth.set_locale(actor, input.locale.clone()).await?;
                        Reply::data(200, serde_json::json!({"locale":input.locale}))
                    }
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            ["permissions"] => {
                no_query(&request)?;
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Reply::data(200, administration::catalog(&self.db, actor).await?)
            }
            ["users"] => match method {
                "GET" => Ok(Reply::page(
                    administration::users(&self.db, actor, query(&request, &["limit", "cursor"])?)
                        .await?,
                )),
                "POST" => {
                    no_query(&request)?;
                    Reply::data(
                        201,
                        administration::create_user(
                            &self.auth,
                            actor,
                            validation::json(&request.body)?,
                        )
                        .await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["users", user] => {
                let user = validation::id(user)?;
                no_query(&request)?;
                match method {
                    "GET" => Reply::data(200, administration::user(&self.db, actor, user).await?),
                    "PATCH" => Reply::data(
                        200,
                        administration::update_user(
                            &self.db,
                            actor,
                            user,
                            validation::json(&request.body)?,
                        )
                        .await?,
                    ),
                    _ => Err(Error::Method("GET, PATCH")),
                }
            }
            ["users", user, "disable"] => {
                no_query(&request)?;
                if method != "POST" {
                    return Err(Error::Method("POST"));
                }
                Reply::data(
                    200,
                    administration::disable_user(
                        &self.db,
                        actor,
                        validation::id(user)?,
                        validation::json(&request.body)?,
                    )
                    .await?,
                )
            }
            ["users", user, "roles"] => {
                let user = validation::id(user)?;
                match method {
                    "GET" => Ok(Reply::page(
                        administration::assignments(
                            &self.db,
                            actor,
                            user,
                            query(&request, &["limit", "cursor"])?,
                        )
                        .await?,
                    )),
                    "POST" => {
                        no_query(&request)?;
                        Reply::data(
                            201,
                            serde_json::json!({"id":administration::assign(&self.db,actor,user,validation::json(&request.body)?).await?}),
                        )
                    }
                    _ => Err(Error::Method("GET, POST")),
                }
            }
            ["users", user, "roles", assignment] => {
                no_query(&request)?;
                if method != "DELETE" {
                    return Err(Error::Method("DELETE"));
                }
                administration::revoke(
                    &self.db,
                    actor,
                    validation::id(user)?,
                    validation::id(assignment)?,
                    validation::json(&request.body)?,
                )
                .await?;
                Ok(Reply::empty())
            }
            ["roles"] => match method {
                "GET" => Ok(Reply::page(
                    administration::roles(&self.db, actor, query(&request, &["limit", "cursor"])?)
                        .await?,
                )),
                "POST" => {
                    no_query(&request)?;
                    Reply::data(
                        201,
                        administration::create_role(
                            &self.db,
                            actor,
                            validation::json(&request.body)?,
                        )
                        .await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["roles", role] => {
                no_query(&request)?;
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    administration::role(&self.db, actor, validation::id(role)?).await?,
                )
            }
            ["roles", role, "permissions"] => {
                no_query(&request)?;
                if method != "PUT" {
                    return Err(Error::Method("PUT"));
                }
                Reply::data(
                    200,
                    administration::replace_permissions(
                        &self.db,
                        actor,
                        validation::id(role)?,
                        validation::json(&request.body)?,
                    )
                    .await?,
                )
            }
            ["clients"] => match method {
                "GET" => Ok(Reply::page(
                    clients::list(
                        &self.db,
                        actor,
                        query(&request, &["limit", "cursor", "q", "tag", "status", "sort"])?,
                    )
                    .await?,
                )),
                "POST" => {
                    no_query(&request)?;
                    Reply::data(
                        201,
                        clients::create(&self.db, actor, validation::json(&request.body)?).await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["clients", client] => {
                let client = validation::id(client)?;
                no_query(&request)?;
                match method {
                    "GET" => Reply::data(200, clients::read(&self.db, actor, client).await?),
                    "PUT" => Reply::data(
                        200,
                        clients::update(&self.db, actor, client, validation::json(&request.body)?)
                            .await?,
                    ),
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            ["clients", client, "archive"] => {
                no_query(&request)?;
                if method != "POST" {
                    return Err(Error::Method("POST"));
                }
                Reply::data(
                    200,
                    clients::archive(
                        &self.db,
                        actor,
                        validation::id(client)?,
                        validation::json(&request.body)?,
                    )
                    .await?,
                )
            }
            [
                "clients",
                client,
                module @ ("analytics" | "commerce" | "marketing"),
                rest @ ..,
            ] => {
                self.report(
                    &request,
                    actor,
                    validation::id(client)?,
                    None,
                    match *module {
                        "analytics" => "ga4",
                        "commerce" => "woocommerce",
                        _ => "meta_ads",
                    },
                    rest,
                )
                .await
            }
            ["clients", client, "integrations", rest @ ..] => {
                self.integrations(&request, actor, validation::id(client)?, None, rest)
                    .await
            }
            ["clients", client, "websites", rest @ ..] => {
                self.websites(&request, actor, validation::id(client)?, rest)
                    .await
            }
            ["clients", client, "tasks", rest @ ..] => {
                self.tasks(&request, actor, validation::id(client)?, rest)
                    .await
            }
            ["clients", client, "plans", rest @ ..] => {
                self.planning(&request, actor, validation::id(client)?, rest)
                    .await
            }
            ["clients", client, "reminders", rest @ ..] => {
                self.reminders(&request, actor, validation::id(client)?, rest)
                    .await
            }
            ["clients", client, "pricing", rest @ ..] => {
                self.pricing(&request, actor, validation::id(client)?, rest)
                    .await
            }
            ["clients", client, "billing", rest @ ..] => {
                self.billing(&request, actor, validation::id(client)?, rest)
                    .await
            }
            _ => Err(Error::NotFound),
        }
    }

    fn unsafe_request(&self, r: &Request) -> Result<()> {
        if single_header(&r.headers, "origin") != Some(self.config.origin.as_str()) {
            return Err(Error::Response(
                StatusCode::FORBIDDEN,
                "origin_forbidden",
                "Request origin is not allowed.",
            ));
        }
        let content_type =
            single_header(&r.headers, "content-type").and_then(|v| v.parse::<mime::Mime>().ok());
        if content_type.is_none_or(|v| v.essence_str() != "application/json") {
            return Err(Error::Response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "content_type_required",
                "Content-Type must be application/json.",
            ));
        }
        Ok(())
    }

    fn login_cookies(&self, token: &str, csrf: &str, expires: &str) -> Vec<String> {
        let date = chrono::DateTime::parse_from_rfc3339(expires)
            .expect("server-owned session expiry")
            .format("%a, %d %b %Y %H:%M:%S GMT");
        let secure = if self.config.secure_cookie {
            "; Secure"
        } else {
            ""
        };
        vec![
            format!(
                "{}={token}; Path=/; Max-Age=43200; Expires={date}; HttpOnly; SameSite=Strict{secure}",
                self.config.session_cookie()
            ),
            format!(
                "{}={csrf}; Path=/; Max-Age=43200; Expires={date}; SameSite=Strict{secure}",
                self.config.csrf_cookie()
            ),
        ]
    }
    pub fn clear_cookies(&self) -> Vec<String> {
        let secure = if self.config.secure_cookie {
            "; Secure"
        } else {
            ""
        };
        vec![
            format!(
                "{}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{secure}",
                self.config.session_cookie()
            ),
            format!(
                "{}=; Path=/; Max-Age=0; SameSite=Strict{secure}",
                self.config.csrf_cookie()
            ),
        ]
    }
}

fn query(r: &Request, keys: &[&str]) -> Result<Query> {
    Query::parse(&r.query, keys)
}
fn no_query(r: &Request) -> Result<()> {
    if r.query_present {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(())
}
fn csrf_error() -> Error {
    Error::Response(
        StatusCode::FORBIDDEN,
        "csrf_failed",
        "Request verification failed.",
    )
}
fn single_header<'a>(headers: &'a HeaderMap, key: &str) -> Option<&'a str> {
    let mut values = headers.get_all(key).iter();
    let first = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        None
    } else {
        Some(first)
    }
}

pub fn cookie(headers: &HeaderMap, key: &str) -> Option<String> {
    let mut found = None;
    for value in headers.get_all("cookie") {
        for pair in value.to_str().ok()?.split(';') {
            let (name, value) = pair.trim().split_once('=')?;
            if name == key {
                if found.is_some() || value.is_empty() {
                    return None;
                }
                found = Some(value.to_owned());
            }
        }
    }
    found
}
