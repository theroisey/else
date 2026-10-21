use crate::{
    audit::{self, Event, Snapshot},
    db::{ADMIN_ROLE, Database},
    error::{Error, Result},
    security::{self, Actor},
    validation,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, SecondsFormat, Utc};
use rand::RngCore;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub mod mail;
pub mod otp;
mod refresh;

#[derive(Clone)]
pub struct Auth {
    pub db: Database,
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
    pub refresh: String,
    pub refresh_expires_at: String,
}

/// Identity addresses must also be representable by the reviewed SMTP parser.
/// This never rewrites persisted legacy addresses.
pub(crate) fn email(value: &str) -> Result<String> {
    let normalized = validation::email(value)?;
    normalized
        .parse::<lettre::Address>()
        .map_err(|_| Error::Invalid("invalid_request"))?;
    Ok(normalized)
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
        Ok(Self { db })
    }

    /// Called only inside admitted OTP consumption or explicitly isolated fixtures.
    pub(crate) fn establish(
        tx: &rusqlite::Transaction<'_>,
        user_id: String,
        request_id: String,
    ) -> Result<LoginResult> {
        let (token, token_hash) = secret();
        let (csrf, csrf_hash) = secret();
        let (refresh, refresh_hash) = secret();
        let session_id = validation::new_id();
        let now = validation::now();
        let expires =
            (Utc::now() + Duration::hours(12)).to_rfc3339_opts(SecondsFormat::Micros, true);
        let refresh_expires =
            (Utc::now() + Duration::days(7)).to_rfc3339_opts(SecondsFormat::Micros, true);
        let current = user(tx, &user_id)?;
        tx.execute(
            "INSERT INTO sessions VALUES (?1,?2,?3,?4,?5,?6,NULL)",
            params![session_id, user_id, token_hash, csrf_hash, now, expires],
        )?;
        tx.execute(
            "INSERT INTO session_refresh_tokens VALUES (?1,?2,?3,?4,?5,NULL)",
            params![refresh_hash, session_id, csrf_hash, now, refresh_expires],
        )?;
        refresh::cleanup(tx, &now)?;
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
                    ..Default::default()
                },
            ),
        )?;
        Ok(LoginResult {
            session: Session {
                actor,
                user: current,
                expires_at: expires,
            },
            token,
            csrf,
            refresh,
            refresh_expires_at: refresh_expires,
        })
    }

    #[cfg(test)]
    pub(crate) async fn test_login(
        &self,
        email: String,
        request_id: String,
    ) -> Result<LoginResult> {
        self.db
            .write(move |tx| {
                let id = tx.query_row(
                    "SELECT id FROM users WHERE email=?1 AND status='active'",
                    [email],
                    |r| r.get(0),
                )?;
                Self::establish(tx, id, request_id)
            })
            .await
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

    pub async fn bootstrap(&self, email: String, name: String) -> Result<String> {
        let email = self::email(&email)?;
        let name = validation::text(&name, 100, true, false)?;
        let hash = "!passwordless";
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
