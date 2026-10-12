//! Unified operational extensions using existing identity, grants and task data.
pub mod allocation;
pub mod automation;
pub mod commercial;
pub mod evidence;
pub(crate) mod integrity;
pub mod managers;
pub mod notifications;
pub mod preferences;
pub mod recurring;
pub mod requests;
pub mod schedule;
pub mod team;
pub mod today;
use crate::{
    error::{Error, Result},
    security::{self, Actor},
    validation,
};
use rusqlite::{Transaction, params};
use sha2::{Digest, Sha256};

/// Only compiled identifiers/permission keys may be interpolated here.
pub(crate) fn grant_sql(user: &str, key: &str, client: &str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id={user} AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND rp.permission_key='{key}' AND (ur.scope_kind='global' OR ur.client_id={client}))"
    )
}
pub(crate) fn hidden(error: Error) -> Error {
    if matches!(error, Error::Denied) {
        Error::NotFound
    } else {
        error
    }
}
pub(crate) fn require(
    tx: &Transaction<'_>,
    actor: &Actor,
    key: &str,
    client: &str,
    writing: bool,
) -> Result<()> {
    security::require(tx, actor, "clients.view", Some(client)).map_err(hidden)?;
    security::require(tx, actor, key, Some(client)).map_err(hidden)?;
    security::client(tx, client, writing)
}
pub(crate) fn hash<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(|_| Error::Internal)?)
    ))
}
pub(crate) fn url(raw: &str) -> Result<String> {
    let text = validation::text(raw, 2048, false, false)?;
    if text.is_empty() {
        return Ok(text);
    }
    let parsed = url::Url::parse(&text).map_err(|_| Error::Invalid("invalid_request"))?;
    if !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(Error::Invalid("invalid_request"));
    }
    // Stored references only: never fetch this URL or treat it as an API origin.
    Ok(text)
}
pub(crate) fn website(tx: &Transaction<'_>, client: &str, id: Option<&str>) -> Result<()> {
    if let Some(id) = id {
        validation::id(id)?;
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM client_websites WHERE id=?1 AND client_id=?2 AND archived_at IS NULL AND needs_review=0)",params![id,client],|r|r.get(0))?;
        if !active {
            return Err(Error::Invalid("invalid_resource_link"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
