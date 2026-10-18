use crate::{
    db::Database,
    error::{Error, Result},
    security::{self, Actor},
    validation,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, SecondsFormat, Utc};
use rand::RngCore;
use rusqlite::{OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const SCOPES: &[&str] = &[
    "clients:read",
    "clients:write",
    "tasks:read",
    "tasks:write",
    "planning:read",
    "planning:write",
    "reminders:read",
    "reminders:write",
    "requests:read",
    "requests:write",
    "requests:develop",
    "requests:review",
    "finance:read",
    "finance:write",
    "analytics:read",
    "teams:read",
    "teams:write",
    "audit:read",
    "admin:read",
    "admin:write",
    "recurring:read",
    "recurring:write",
    "notifications:read",
    "notifications:write",
];

/// Hashes and immutable authority references only. Never contains a plaintext credential.
#[derive(Clone)]
pub struct Delegation {
    pub token_hash: Vec<u8>,
    pub grant_id: String,
    pub application_id: String,
    pub client_id: Option<String>,
    pub resource: String,
    pub scopes: BTreeSet<String>,
}

#[derive(Clone)]
pub struct Command {
    pub id: String,
    pub tool: String,
    pub digest: String,
    pub kind: &'static str,
    pub approval_id: Option<String>,
    pub high_impact: bool,
}

pub fn scopes(raw: &str) -> Result<BTreeSet<String>> {
    if raw.len() > 2048 {
        return Err(Error::Invalid("invalid_scope"));
    }
    let parts: Vec<_> = raw.split(' ').collect();
    let result: BTreeSet<_> = parts.iter().map(|v| (*v).to_owned()).collect();
    if result.is_empty()
        || result.len() != parts.len()
        || result.iter().any(|v| !SCOPES.contains(&v.as_str()))
    {
        return Err(Error::Invalid("invalid_scope"));
    }
    Ok(result)
}
pub fn scope_text(scopes: &BTreeSet<String>) -> String {
    scopes.iter().cloned().collect::<Vec<_>>().join(" ")
}
pub fn opaque() -> (String, Vec<u8>) {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    (
        URL_SAFE_NO_PAD.encode(bytes),
        Sha256::digest(bytes).to_vec(),
    )
}
pub fn token_hash(raw: &str) -> Result<Vec<u8>> {
    if raw.len() != 43 {
        return Err(Error::Unauthorized);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| Error::Unauthorized)?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != raw {
        return Err(Error::Unauthorized);
    }
    Ok(Sha256::digest(bytes).to_vec())
}
pub fn until(seconds: i64) -> Result<String> {
    Utc::now()
        .checked_add_signed(Duration::seconds(seconds))
        .map(|v| v.to_rfc3339_opts(SecondsFormat::Micros, true))
        .ok_or(Error::Internal)
}
pub fn enabled(tx: &Transaction<'_>) -> Result<()> {
    let enabled: bool = tx.query_row("SELECT enabled FROM mcp_settings WHERE id=1", [], |r| {
        r.get(0)
    })?;
    if enabled {
        Ok(())
    } else {
        Err(Error::Response(
            http::StatusCode::SERVICE_UNAVAILABLE,
            "mcp_disabled",
            "MCP access is disabled.",
        ))
    }
}
pub fn grant_active(tx: &Transaction<'_>, user: &str, grant: &str) -> Result<()> {
    enabled(tx)?;
    let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_grants g JOIN mcp_applications a ON a.id=g.application_id JOIN users u ON u.id=g.user_id WHERE g.id=?1 AND g.user_id=?2 AND g.revoked_at IS NULL AND g.expires_at>?3 AND a.revoked_at IS NULL AND u.status='active')",params![grant,user,validation::now()],|r|r.get(0))?;
    if valid {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}
pub fn fresh(tx: &Transaction<'_>, actor: &Actor, delegation: &Delegation) -> Result<()> {
    grant_active(tx, &actor.user_id, &delegation.grant_id)?;
    let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_access_tokens t JOIN mcp_grants g ON g.id=t.grant_id WHERE t.token_hash=?1 AND t.grant_id=?2 AND t.expires_at>?3 AND g.application_id=?4 AND g.client_id IS ?5 AND t.scopes=?6 AND g.resource=?7)",params![delegation.token_hash,delegation.grant_id,validation::now(),delegation.application_id,delegation.client_id,scope_text(&delegation.scopes),delegation.resource],|r|r.get(0))?;
    if valid {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}
pub async fn authenticate(
    db: &Database,
    token: &str,
    resource: String,
    request_id: String,
) -> Result<Actor> {
    let hash = token_hash(token)?;
    db.read(move|tx| {
        let found:Option<(String,String,String,Option<String>,String)>=tx.query_row("SELECT g.user_id,g.id,g.application_id,g.client_id,t.scopes FROM mcp_access_tokens t JOIN mcp_grants g ON g.id=t.grant_id WHERE t.token_hash=?1 AND t.expires_at>?2 AND g.resource=?3",params![hash,validation::now(),resource],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let (user,grant_id,application_id,client_id,scope)=found.ok_or(Error::Unauthorized)?;
        let actor=Actor::mcp(user,request_id,Delegation{token_hash:hash,grant_id,application_id,client_id,resource,scopes:scopes(&scope)?});
        security::fresh(tx,&actor)?; Ok(actor)
    }).await
}

pub fn scope_permission(key: &str) -> Option<&'static str> {
    Some(match key {
        "clients.view" => "clients:read",
        "clients.create" | "clients.update" | "clients.archive" => "clients:write",
        "activity.view" => "clients:read",
        "tasks.view" | "tasks.read_own" | "tasks.read_team" | "tasks.read_development" => {
            "tasks:read"
        }
        "tasks.create" | "tasks.update" | "tasks.update_own" | "tasks.delete" | "tasks.manage"
        | "tasks.assign_team" => "tasks:write",
        "planning.view" => "planning:read",
        "planning.create" | "planning.update" | "planning.archive" => "planning:write",
        "reminders.view" => "reminders:read",
        "reminders.create" | "reminders.update" => "reminders:write",
        "tickets.read_own" | "tickets.read_team" | "tickets.read_all" => "requests:read",
        "tickets.create" | "tickets.reopen" | "tickets.cancel" => "requests:write",
        "tickets.accept" | "tickets.reject" | "tickets.assign" | "tickets.deliver" => {
            "requests:develop"
        }
        "tickets.approve" | "tickets.request_revision" => "requests:review",
        "expenses.view"
        | "billing.view"
        | "pricing.view"
        | "agreements.view"
        | "finance.read_company" => "finance:read",
        "billing.manage"
        | "billing.create"
        | "billing.update"
        | "billing.delete"
        | "billing.reverse"
        | "pricing.manage"
        | "agreements.manage"
        | "finance.approve_adjustment" => "finance:write",
        "analytics.view" | "integrations.view" => "analytics:read",
        "staff.read_team" => "teams:read",
        "staff.manage" | "staff.assign_brands" => "teams:write",
        "audit.view" => "audit:read",
        "users.view" | "roles.view" => "admin:read",
        "users.manage" | "roles.manage" => "admin:write",
        "recurring.view" => "recurring:read",
        "recurring.manage" => "recurring:write",
        _ => return None,
    })
}
pub fn permits(delegation: &Delegation, key: &str, client: Option<&str>) -> bool {
    if let Some(bound) = &delegation.client_id {
        // No client-specific delegation can acquire global administration.
        if client != Some(bound.as_str()) {
            return false;
        }
    }
    scope_permission(key).is_some_and(|scope| delegation.scopes.contains(scope))
}
/// A compiled visibility predicate may be narrowed, never widened, by delegation.
pub(crate) fn predicate(
    actor: &Actor,
    scope: &str,
    column: &str,
    original: String,
) -> Result<String> {
    let Some(d) = actor.delegation() else {
        return Ok(original);
    };
    if !d.scopes.contains(scope) {
        return Ok("0".into());
    }
    if let Some(c) = &d.client_id {
        let c = validation::id(c)?;
        Ok(format!("(({original}) AND {column}='{c}')"))
    } else {
        Ok(original)
    }
}

/// Consent cannot mint latent scopes the subject cannot currently exercise.
/// Resource scope is also a ceiling on global administration.
pub fn available_scopes(
    tx: &Transaction<'_>,
    user: &str,
    client: Option<&str>,
) -> Result<BTreeSet<String>> {
    let grants = security::grants(tx, user)?;
    let mut available = BTreeSet::from(["notifications:read".into(), "notifications:write".into()]);
    for grant in grants {
        let Some(scope) = scope_permission(&grant.permission) else {
            continue;
        };
        let Some((_, kind, _)) = crate::db::PERMISSIONS
            .iter()
            .find(|p| p.0 == grant.permission)
        else {
            continue;
        };
        if *kind == "global" && client.is_some() {
            continue;
        }
        if grant.scope == "client" && client.is_some_and(|c| grant.client_id.as_deref() != Some(c))
        {
            continue;
        }
        available.insert(scope.to_owned());
    }
    Ok(available)
}
