use std::{env, net::SocketAddr, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub address: SocketAddr,
    pub database: PathBuf,
    pub frontend: PathBuf,
    pub origin: String,
    pub secure_cookie: bool,
    pub key_file: PathBuf,
    pub key_provision: bool,
    pub key_restored: bool,
}

impl Config {
    pub fn load() -> std::result::Result<Self, &'static str> {
        let address = env::var("HTTP_ADDRESS")
            .unwrap_or_else(|_| "127.0.0.1:8080".into())
            .parse()
            .map_err(|_| "invalid_http_address")?;
        let database = PathBuf::from(
            env::var("DATABASE_PATH")
                .unwrap_or_else(|_| "/var/lib/roisey-else/else.sqlite3".into()),
        );
        let frontend = PathBuf::from(
            env::var("FRONTEND_DIRECTORY").unwrap_or_else(|_| "/app/frontend".into()),
        );
        if !database.is_absolute() || !frontend.is_absolute() {
            return Err("invalid_runtime_paths");
        }
        let origin =
            env::var("AUTH_PUBLIC_ORIGIN").unwrap_or_else(|_| "http://localhost:8080".into());
        let parsed = url::Url::parse(&origin).map_err(|_| "invalid_public_origin")?;
        let secure_cookie = match env::var("AUTH_COOKIE_SECURE").as_deref() {
            Ok("true") => true,
            Ok("false") => false,
            Err(_) => true,
            _ => return Err("invalid_cookie_configuration"),
        };
        let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if parsed.origin().ascii_serialization() != origin
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !(parsed.scheme() == "https"
                || (parsed.scheme() == "http" && local && !secure_cookie))
            || (secure_cookie && parsed.scheme() != "https")
        {
            return Err("invalid_public_origin");
        }
        let key_provision = env::var_os("INTEGRATION_KEYRING_FILE").is_none();
        let key_file = if key_provision {
            database
                .parent()
                .ok_or("invalid_database_path")?
                .join(".control/integration-keyring.json")
        } else {
            PathBuf::from(
                env::var_os("INTEGRATION_KEYRING_FILE").ok_or("integration_key_startup_failed")?,
            )
        };
        let key_restored = match env::var("INTEGRATION_KEYRING_MODE").as_deref() {
            Ok("restored") => true,
            Ok("normal") | Err(env::VarError::NotPresent) => false,
            _ => return Err("integration_key_startup_failed"),
        };
        if !key_file.is_absolute()
            || key_file.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::CurDir | std::path::Component::ParentDir
                )
            })
        {
            return Err("integration_key_startup_failed");
        }
        Ok(Self {
            address,
            database,
            frontend,
            origin,
            secure_cookie,
            key_file,
            key_provision,
            key_restored,
        })
    }

    pub fn session_cookie(&self) -> &'static str {
        if self.secure_cookie {
            "__Host-else_session"
        } else {
            "else_session"
        }
    }

    pub fn csrf_cookie(&self) -> &'static str {
        if self.secure_cookie {
            "__Host-else_csrf"
        } else {
            "else_csrf"
        }
    }
}
