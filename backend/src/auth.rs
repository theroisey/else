use crate::{
    audit::{self, Event, Snapshot},
    db::{ADMIN_ROLE, Database},
    error::{Error, Result},
    security::{self, Actor},
    validation,
};
use argon2::{
    Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version,
    password_hash::SaltString,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, SecondsFormat, Utc};
use rand::RngCore;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration as StdDuration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct Auth {
    pub db: Database,
    work: Arc<Semaphore>,
    dummy_hash: String,
    limiter: Arc<Mutex<LoginBuckets>>,
}

type LoginBuckets = HashMap<[u8; 32], (Instant, u8)>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Login {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub permissions: Vec<security::Grant>,
}

pub struct Session {
    pub actor: Actor,
    pub user: User,
    pub expires_at: String,
}

impl Session {
    pub fn document(&self) -> serde_json::Value {
        serde_json::json!({"data":{"user":self.user,"session":{"expires_at":self.expires_at}}})
    }
}

pub struct LoginResult {
    pub session: Session,
    pub token: String,
    pub csrf: String,
}

fn argon() -> Argon2<'static> {
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19 * 1024, 2, 1, Some(32)).expect("fixed Argon2 parameters"),
    )
}

pub fn hash_password(password: &str) -> Result<String> {
    if !(12..=128).contains(&password.len()) {
        return Err(Error::Invalid("invalid_request"));
    }
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let salt = SaltString::encode_b64(&salt).map_err(|_| Error::Internal)?;
    argon()
        .hash_password(password.as_bytes(), &salt)
        .map(|v| v.to_string())
        .map_err(|_| Error::Internal)
}

fn verify_password(hash: &str, password: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    let mut salt = [0u8; 64];
    if parsed
        .salt
        .and_then(|s| s.decode_b64(&mut salt).ok())
        .map(|s| s.len())
        != Some(16)
    {
        return false;
    }
    // Imported passwords use exactly these reviewed bounds. Never run attacker-controlled cost parameters.
    if parsed.algorithm.as_str() != "argon2id"
        || parsed.version != Some(19)
        || parsed.params.get_decimal("m") != Some(19 * 1024)
        || parsed.params.get_decimal("t") != Some(2)
        || parsed.params.get_decimal("p") != Some(1)
        || parsed.hash.as_ref().map(|h| h.len()) != Some(32)
    {
        return false;
    }
    argon()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub fn secret() -> (String, Vec<u8>) {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    (
        URL_SAFE_NO_PAD.encode(bytes),
        Sha256::digest(bytes).to_vec(),
    )
}

fn digest(raw: &str) -> Result<Vec<u8>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| Error::Unauthorized)?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != raw {
        return Err(Error::Unauthorized);
    }
    Ok(Sha256::digest(bytes).to_vec())
}

impl Auth {
    pub fn new(db: Database) -> Result<Self> {
        Ok(Self {
            db,
            work: Arc::new(Semaphore::new(2)),
            dummy_hash: hash_password(&secret().0)?,
            limiter: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn limit(&self, peer: &str, email: &str) -> Result<()> {
        let key: [u8; 32] =
            Sha256::digest(format!("{peer}\0{}", email.trim().to_ascii_lowercase())).into();
        let mut buckets = self.limiter.lock().map_err(|_| Error::Internal)?;
        let now = Instant::now();
        if let Some((started, count)) = buckets.get_mut(&key)
            && now.duration_since(*started) < StdDuration::from_secs(900)
        {
            if *count >= 5 {
                return Err(Error::Response(
                    http::StatusCode::TOO_MANY_REQUESTS,
                    "authentication_rate_limited",
                    "Authentication is temporarily unavailable.",
                ));
            }
            *count += 1;
            return Ok(());
        }
        if buckets.len() >= 10000 {
            buckets
                .retain(|_, (start, _)| now.duration_since(*start) < StdDuration::from_secs(900));
            if buckets.len() >= 10000 {
                return Err(Error::Busy);
            }
        }
        buckets.insert(key, (now, 1));
        Ok(())
    }

    pub async fn hash(&self, password: String) -> Result<String> {
        let permit = self
            .work
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            hash_password(&password)
        })
        .await
        .map_err(|_| Error::Internal)?
    }

    pub async fn login(&self, input: Login, request_id: String) -> Result<LoginResult> {
        let invalid = || {
            Error::Response(
                http::StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "Email or password is incorrect.",
            )
        };
        let email = validation::email(&input.email).map_err(|_| invalid())?;
        if !(12..=128).contains(&input.password.len()) {
            return Err(invalid());
        }
        let stored = self
            .db
            .read(move |tx| {
                Ok(tx
                    .query_row(
                        "SELECT id,password_hash FROM users WHERE email=?1 AND status='active'",
                        [email],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )
                    .optional()?)
            })
            .await?;
        let hash = stored
            .as_ref()
            .map(|v| v.1.clone())
            .unwrap_or(self.dummy_hash.clone());
        let expected_hash = hash.clone();
        let permit = self
            .work
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let valid = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            verify_password(&hash, &input.password)
        })
        .await
        .map_err(|_| Error::Internal)?;
        let Some((user_id, _)) = stored.filter(|_| valid) else {
            return Err(invalid());
        };
        let (token, token_hash) = secret();
        let (csrf, csrf_hash) = secret();
        let session_id = validation::new_id();
        let expires =
            (Utc::now() + Duration::hours(12)).to_rfc3339_opts(SecondsFormat::Micros, true);
        let result = self
            .db
            .write(move |tx| {
                let current: String = tx
                    .query_row(
                        "SELECT password_hash FROM users WHERE id=?1 AND status='active'",
                        [&user_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .ok_or_else(invalid)?;
                if current != expected_hash {
                    return Err(invalid());
                }
                let now = validation::now();
                tx.execute(
                    "INSERT INTO sessions VALUES (?1,?2,?3,?4,?5,?6,NULL)",
                    params![session_id, user_id, token_hash, csrf_hash, now, expires],
                )?;
                tx.execute(
                    "UPDATE users SET last_login_at=?1 WHERE id=?2",
                    params![now, user_id],
                )?;
                let actor = Actor::session(user_id, session_id, csrf_hash, request_id);
                audit::mutation(
                    tx,
                    &actor,
                    "session",
                    &actor.session_id,
                    None,
                    "created",
                    (
                        None,
                        Snapshot {
                            exists: Some(true),
                            ..Snapshot::default()
                        },
                    ),
                )?;
                Ok(Session {
                    user: user(tx, &actor.user_id)?,
                    actor,
                    expires_at: expires,
                })
            })
            .await?;
        Ok(LoginResult {
            session: result,
            token,
            csrf,
        })
    }

    pub async fn current(&self, token: &str, request_id: String) -> Result<Session> {
        let token_hash = digest(token)?;
        self.db.read(move |tx| {
            let (session_id,user_id,csrf_hash,expires):(String,String,Vec<u8>,String)=tx.query_row("SELECT s.id,s.user_id,s.csrf_hash,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.revoked_at IS NULL AND s.expires_at>?2 AND u.status='active'",params![token_hash,validation::now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or(Error::Unauthorized)?;
            let actor=Actor::session(user_id,session_id,csrf_hash,request_id);
            Ok(Session {user:user(tx,&actor.user_id)?,actor,expires_at:expires})
        }).await
    }

    pub fn csrf(actor: &Actor, cookie: &str, header: &str) -> bool {
        if cookie.len() != header.len() || !bool::from(cookie.as_bytes().ct_eq(header.as_bytes())) {
            return false;
        }
        match digest(cookie) {
            Ok(hash) => bool::from(hash.ct_eq(&actor.csrf_hash)),
            Err(_) => false,
        }
    }

    pub async fn logout(&self, actor: Actor) -> Result<()> {
        self.db
            .write(move |tx| {
                security::fresh(tx, &actor)?;
                tx.execute(
                    "UPDATE sessions SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL",
                    params![validation::now(), actor.session_id],
                )?;
                audit::mutation(
                    tx,
                    &actor,
                    "session",
                    &actor.session_id,
                    None,
                    "archived",
                    (
                        Some(Snapshot {
                            exists: Some(true),
                            ..Snapshot::default()
                        }),
                        Snapshot {
                            exists: Some(false),
                            ..Snapshot::default()
                        },
                    ),
                )?;
                Ok(())
            })
            .await
    }

    pub async fn locale(&self, actor: Actor) -> Result<Option<String>> {
        self.db
            .read(move |tx| {
                security::fresh(tx, &actor)?;
                Ok(tx
                    .query_row(
                        "SELECT locale FROM user_locale_preferences WHERE user_id=?1",
                        [actor.user_id],
                        |r| r.get(0),
                    )
                    .optional()?)
            })
            .await
    }

    pub async fn set_locale(&self, actor: Actor, locale: String) -> Result<()> {
        if !["en", "tr", "ro", "de", "fr"].contains(&locale.as_str()) {
            return Err(Error::Invalid("invalid_request"));
        }
        self.db.write(move |tx| {
            security::fresh(tx,&actor)?;
            let previous:Option<i64>=tx.query_row("SELECT revision FROM user_locale_preferences WHERE user_id=?1",[&actor.user_id],|r|r.get(0)).optional()?;
            let next=previous.unwrap_or(0).checked_add(1).ok_or(Error::Conflict("conflict"))?;
            tx.execute("INSERT INTO user_locale_preferences VALUES (?1,?2,?3) ON CONFLICT(user_id) DO UPDATE SET locale=excluded.locale,revision=excluded.revision",params![actor.user_id,locale,next])?;
            audit::mutation(tx,&actor,"user_preference",&actor.user_id,None,if previous.is_some(){"updated"}else{"created"},(previous.map(Snapshot::revision), Snapshot::revision(next)))?;
            Ok(())
        }).await
    }

    pub async fn bootstrap(&self, email: String, name: String, password: String) -> Result<String> {
        let email = validation::email(&email)?;
        let name = validation::text(&name, 100, true, false)?;
        let hash = self.hash(password).await?;
        self.db.write(move |tx| {
            let initialized:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM users)",[],|r|r.get(0))?;
            if initialized {return Err(Error::Conflict("already_initialized"));}
            let id=validation::new_id();let assignment=validation::new_id();let now=validation::now();
            tx.execute("INSERT INTO users (id,email,display_name,password_hash,status,bootstrap_admin,created_at,updated_at) VALUES (?1,?2,?3,?4,'active',1,?5,?5)",params![id,email,name,hash,now])?;
            tx.execute("INSERT INTO user_roles (id,user_id,role_id,scope_kind,assigned_at) VALUES (?1,?2,?3,'global',?4)",params![assignment,id,ADMIN_ROLE,now])?;
            let correlation=audit::request_id();
            for (kind,resource) in [("user",&id),("role_assignment",&assignment)] {
                audit::append(tx,Event {actor:None,request_id:&correlation,kind,id:resource,client:None,action:"created",before:None,after:Some(Snapshot {exists:Some(true),..Snapshot::default()}),source:"cli"})?;
            }
            Ok(id)
        }).await
    }
}

fn user(tx: &rusqlite::Transaction<'_>, id: &str) -> Result<User> {
    let mut user = tx.query_row(
        "SELECT id,email,display_name FROM users WHERE id=?1 AND status='active'",
        [id],
        |r| {
            Ok(User {
                id: r.get(0)?,
                email: r.get(1)?,
                display_name: r.get(2)?,
                permissions: vec![],
            })
        },
    )?;
    user.permissions = security::grants(tx, id)?;
    Ok(user)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn session_revocation_csrf_and_atomic_audit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("else.sqlite3");
        let auth = Auth::new(Database::open(&path, true).unwrap()).unwrap();
        auth.bootstrap(
            "Admin@Example.com".into(),
            "Synthetic administrator".into(),
            "synthetic-password".into(),
        )
        .await
        .unwrap();
        assert!(
            auth.bootstrap(
                "other@example.com".into(),
                "Other".into(),
                "synthetic-password".into()
            )
            .await
            .is_err()
        );
        let login = auth
            .login(
                Login {
                    email: "admin@example.com".into(),
                    password: "synthetic-password".into(),
                },
                audit::request_id(),
            )
            .await
            .unwrap();
        assert!(Auth::csrf(&login.session.actor, &login.csrf, &login.csrf));
        assert!(!Auth::csrf(&login.session.actor, &login.csrf, "wrong"));
        assert!(
            login
                .session
                .user
                .permissions
                .iter()
                .any(|g| g.permission == "users.manage")
        );
        let conn = crate::db::connection(&path).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
        assert!(auth.logout(login.session.actor.clone()).await.is_err());
        assert!(
            auth.current(&login.token, audit::request_id())
                .await
                .is_ok()
        );
        conn.execute_batch("DROP TRIGGER reject_audit;").unwrap();
        auth.logout(login.session.actor).await.unwrap();
        assert!(
            auth.current(&login.token, audit::request_id())
                .await
                .is_err()
        );
    }

    #[test]
    fn imported_hash_and_bounded_cost_policy() {
        let hash = hash_password("synthetic-password").unwrap();
        assert!(verify_password(&hash, "synthetic-password"));
        assert!(!verify_password(&hash, "different-password"));
        assert!(!verify_password(
            &hash.replace("m=19456", "m=9999999"),
            "synthetic-password"
        ));
    }
}
