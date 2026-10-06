use crate::{
    db::PERMISSIONS,
    error::{Error, Result},
    validation,
};
use rusqlite::{Transaction, params};
use serde::Serialize;

#[derive(Clone)]
pub struct Actor {
    pub user_id: String,
    pub session_id: String,
    pub csrf_hash: Vec<u8>,
    pub request_id: String,
    principal: Principal,
}

#[derive(Clone)]
enum Principal {
    Session,
    Operator,
}
impl Actor {
    pub(crate) fn session(
        user_id: String,
        session_id: String,
        csrf_hash: Vec<u8>,
        request_id: String,
    ) -> Self {
        Self {
            user_id,
            session_id,
            csrf_hash,
            request_id,
            principal: Principal::Session,
        }
    }
    /// Trusted local operator attribution, never constructed from an HTTP body.
    /// File/CLI access is the external authority boundary; grants stay fresh.
    pub fn operator(user_id: String) -> Result<Self> {
        validation::id(&user_id)?;
        Ok(Self {
            user_id,
            session_id: String::new(),
            csrf_hash: Vec::new(),
            request_id: crate::audit::request_id(),
            principal: Principal::Operator,
        })
    }
    pub fn source(&self) -> &'static str {
        match self.principal {
            Principal::Session => "http",
            Principal::Operator => "cli",
        }
    }
}

#[derive(Serialize)]
pub struct Grant {
    pub permission: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

pub fn fresh(tx: &Transaction<'_>, actor: &Actor) -> Result<()> {
    if matches!(actor.principal, Principal::Operator) {
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND status='active')",
            [&actor.user_id],
            |r| r.get(0),
        )?;
        return if active {
            Ok(())
        } else {
            Err(Error::Unauthorized)
        };
    }
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.revoked_at IS NULL AND s.expires_at>?3 AND u.status='active')",
        params![actor.session_id,actor.user_id,validation::now()],|r|r.get(0))?;
    if active {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}

pub fn allowed_user(
    tx: &Transaction<'_>,
    user: &str,
    key: &str,
    client: Option<&str>,
) -> Result<bool> {
    let Some((_, scope, _)) = PERMISSIONS.iter().find(|p| p.0 == key) else {
        return Ok(false);
    };
    if (*scope == "global" && client.is_some()) || (*scope == "client" && client.is_none()) {
        return Ok(false);
    }
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE u.id=?1 AND u.status='active' AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND rp.permission_key=?2 AND (ur.scope_kind='global' OR (?3 IS NOT NULL AND ur.scope_kind='client' AND ur.client_id=?3)))",
        params![user,key,client],|r|r.get(0))?)
}

pub fn require(tx: &Transaction<'_>, actor: &Actor, key: &str, client: Option<&str>) -> Result<()> {
    fresh(tx, actor)?;
    if allowed_user(tx, &actor.user_id, key, client)? {
        Ok(())
    } else {
        Err(Error::Denied)
    }
}

pub fn require_any(tx: &Transaction<'_>, actor: &Actor, keys: &[&str], client: &str) -> Result<()> {
    fresh(tx, actor)?;
    for key in keys {
        if allowed_user(tx, &actor.user_id, key, Some(client))? {
            return Ok(());
        }
    }
    Err(Error::Denied)
}

pub fn grants(tx: &Transaction<'_>, user: &str) -> Result<Vec<Grant>> {
    let mut statement=tx.prepare("SELECT DISTINCT rp.permission_key,ur.scope_kind,ur.client_id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.permission_key=rp.permission_key WHERE u.id=?1 AND u.status='active' AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND (ur.scope_kind='global' OR p.scope_kind='client') ORDER BY rp.permission_key,ur.scope_kind,ur.client_id")?;
    let rows = statement.query_map([user], |row| {
        Ok(Grant {
            permission: row.get(0)?,
            scope: row.get(1)?,
            client_id: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn client(tx: &Transaction<'_>, client: &str, writing: bool) -> Result<()> {
    let archived: Option<String> = tx.query_row(
        "SELECT archived_at FROM clients WHERE id=?1",
        [client],
        |r| r.get(0),
    )?;
    if writing && archived.is_some() {
        return Err(Error::Conflict("conflict"));
    }
    Ok(())
}

pub fn preserve_administrator(tx: &Transaction<'_>) -> Result<()> {
    let mut statement = tx.prepare("SELECT id FROM users WHERE status='active'")?;
    let users = statement
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for user in users {
        if allowed_user(tx, &user, "users.manage", None)?
            && allowed_user(tx, &user, "roles.manage", None)?
        {
            return Ok(());
        }
    }
    Err(Error::Conflict("last_administrator"))
}
