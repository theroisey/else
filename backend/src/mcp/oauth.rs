//! Public-client Authorization Code + PKCE and opaque rotating credentials.
//! Registration is explicit pre-registration; no metadata URL is fetched.
use super::access;
use crate::{
    audit,
    config::Config,
    db::Database,
    error::{Error, Result},
    query::Query,
    security::{self, Actor},
    validation,
};
use oauth2::{PkceCodeChallenge, PkceCodeVerifier};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use subtle::ConstantTimeEq;

pub const AUTH_KEYS: &[&str] = &[
    "response_type",
    "client_id",
    "redirect_uri",
    "resource",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
];
pub const TOKEN_KEYS: &[&str] = &[
    "grant_type",
    "client_id",
    "resource",
    "code",
    "redirect_uri",
    "code_verifier",
    "refresh_token",
    "scope",
];
type CodeRecord = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
);
const FAMILY_SECONDS: i64 = 30 * 24 * 60 * 60;
const ACCESS_SECONDS: i64 = 15 * 60;

pub fn resource(config: &Config) -> String {
    format!("{}/mcp", config.origin)
}
pub fn resource_metadata(config: &Config) -> Value {
    json!({"resource":resource(config),"authorization_servers":[config.origin],"scopes_supported":access::SCOPES,"bearer_methods_supported":["header"],"resource_documentation":"https://github.com/theroisey/else/blob/main/notes/mcp.md"})
}
pub fn server_metadata(config: &Config) -> Value {
    json!({"issuer":config.origin,"authorization_endpoint":format!("{}/oauth/authorize",config.origin),"token_endpoint":format!("{}/oauth/token",config.origin),"revocation_endpoint":format!("{}/oauth/revoke",config.origin),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none"],"revocation_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"],"scopes_supported":access::SCOPES,"authorization_response_iss_parameter_supported":true})
}

pub fn redirect(raw: &str) -> Result<String> {
    if raw.len() > 2048 {
        return Err(Error::Invalid("invalid_redirect_uri"));
    }
    let url = url::Url::parse(raw).map_err(|_| Error::Invalid("invalid_redirect_uri"))?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && local))
        || url.as_str() != raw
    {
        return Err(Error::Invalid("invalid_redirect_uri"));
    }
    if url
        .query_pairs()
        .any(|(k, _)| matches!(k.as_ref(), "code" | "state" | "iss" | "error"))
    {
        return Err(Error::Invalid("invalid_redirect_uri"));
    }
    Ok(raw.to_owned())
}
fn required<'a>(q: &'a Query, key: &str) -> Result<&'a str> {
    q.get(key).ok_or(Error::Invalid("invalid_request"))
}
fn application(tx: &Transaction<'_>, id: &str) -> Result<()> {
    validation::id(id).map_err(|_| Error::Invalid("invalid_client"))?;
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM mcp_applications WHERE id=?1 AND revoked_at IS NULL)",
        [id],
        |r| r.get(0),
    )?;
    if active {
        Ok(())
    } else {
        Err(Error::Invalid("invalid_client"))
    }
}
pub async fn start(db: &Database, config: &Config, q: Query) -> Result<String> {
    if required(&q, "response_type")? != "code" {
        return Err(Error::Invalid("unsupported_response_type"));
    }
    if required(&q, "resource")? != resource(config) {
        return Err(Error::Invalid("invalid_target"));
    }
    if required(&q, "code_challenge_method")? != "S256" {
        return Err(Error::Invalid("invalid_request"));
    }
    let id = validation::new_id();
    let app = validation::id(required(&q, "client_id")?)?;
    let uri = redirect(required(&q, "redirect_uri")?)?;
    let scopes = access::scope_text(&access::scopes(required(&q, "scope")?)?);
    let challenge = required(&q, "code_challenge")?.to_owned();
    // S256 challenges are canonical unpadded SHA-256 encodings.
    access::token_hash(&challenge).map_err(|_| Error::Invalid("invalid_request"))?;
    let state = q.get("state").unwrap_or("").to_owned();
    if state.len() > 512 || state.chars().any(char::is_control) {
        return Err(Error::Invalid("invalid_request"));
    }
    let result = id.clone();
    let target = resource(config);
    db.write(move|tx|{
        access::enabled(tx)?;application(tx,&app)?;
        let registered:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_redirects WHERE application_id=?1 AND uri=?2)",params![app,uri],|r|r.get(0))?;
        if !registered{return Err(Error::Invalid("invalid_redirect_uri"));}
        // Expired transient challenges can be removed; grants, approvals, commands and business history are retained.
        tx.execute("DELETE FROM mcp_authorizations WHERE expires_at<?1 AND consumed_at IS NULL",[validation::now()])?;
        let active:i64=tx.query_row("SELECT count(*) FROM mcp_authorizations WHERE consumed_at IS NULL AND expires_at>?1",[validation::now()],|r|r.get(0))?;
        if active>=1024{return Err(Error::Busy);}
        tx.execute("INSERT INTO mcp_authorizations(id,application_id,redirect_uri,resource,scopes,challenge,state,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,app,uri,target,scopes,challenge,state,validation::now(),access::until(600)?])?;Ok(())
    }).await?;
    Ok(format!("{}/app/mcp/authorize/{result}", config.origin))
}

pub async fn pending(db: &Database, actor: Actor, id: String) -> Result<Value> {
    db.read(move|tx|{
        security::fresh(tx,&actor)?;access::enabled(tx)?;
        let mut value=tx.query_row("SELECT a.name,r.redirect_uri,r.scopes,r.expires_at FROM mcp_authorizations r JOIN mcp_applications a ON a.id=r.application_id WHERE r.id=?1 AND r.consumed_at IS NULL AND r.expires_at>?2 AND a.revoked_at IS NULL",params![id,validation::now()],|r|Ok(json!({"id":id,"application_name":r.get::<_,String>(0)?,"redirect_uri":r.get::<_,String>(1)?,"scopes":r.get::<_,String>(2)?.split(' ').collect::<Vec<_>>(),"expires_at":r.get::<_,String>(3)?}))).optional()?.ok_or(Error::NotFound)?;let available=access::available_scopes(tx,&actor.user_id,None)?;let requested=value["scopes"].as_array_mut().ok_or(Error::Internal)?;requested.retain(|v|v.as_str().is_some_and(|scope|available.contains(scope)));Ok(value)
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Consent {
    pub approve: bool,
    pub scopes: Vec<String>,
    pub client_id: Option<String>,
}
pub async fn consent(
    db: &Database,
    config: &Config,
    actor: Actor,
    id: String,
    input: Consent,
) -> Result<Value> {
    if input.scopes.len() > access::SCOPES.len() {
        return Err(Error::Invalid("invalid_scope"));
    }
    let requested = if input.approve {
        access::scopes(&input.scopes.join(" "))?
    } else {
        BTreeSet::new()
    };
    let client = input.client_id.map(|s| validation::id(&s)).transpose()?;
    let issuer = config.origin.clone();
    let audience = resource(config);
    db.write(move|tx|{
        security::fresh(tx,&actor)?;access::enabled(tx)?;
        let row:Option<(String,String,String,String)>=tx.query_row("SELECT r.application_id,r.redirect_uri,r.scopes,r.state FROM mcp_authorizations r JOIN mcp_applications a ON a.id=r.application_id WHERE r.id=?1 AND r.consumed_at IS NULL AND r.expires_at>?2 AND a.revoked_at IS NULL AND r.resource=?3",params![id,validation::now(),audience],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let (app,redirect,original,state)=row.ok_or(Error::NotFound)?;
        if !requested.is_subset(&access::scopes(&original)?){return Err(Error::Invalid("invalid_scope"));}
        if let Some(client)=&client {
            // An actual current brand reader may restrict delegation to that brand.
            security::require(tx,&actor,"clients.view",Some(client))?;
        }
        let requested:BTreeSet<String>=requested.intersection(&access::available_scopes(tx,&actor.user_id,client.as_deref())?).cloned().collect();
        if input.approve && requested.is_empty(){return Err(Error::Invalid("invalid_scope"));}
        tx.execute("UPDATE mcp_authorizations SET consumed_at=?1,state='' WHERE id=?2",params![validation::now(),id])?;
        let mut url=url::Url::parse(&redirect).map_err(|_|Error::Internal)?;
        if input.approve{
            let grant=validation::new_id();let (code,hash)=access::opaque();let now=validation::now();
            let active:i64=tx.query_row("SELECT count(*) FROM mcp_grants WHERE user_id=?1 AND revoked_at IS NULL AND expires_at>?2",params![actor.user_id,now],|r|r.get(0))?;
            if active>=128{return Err(Error::Busy);}
            tx.execute("INSERT INTO mcp_grants(id,user_id,application_id,client_id,scopes,resource,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![grant,actor.user_id,app,client,access::scope_text(&requested),audience,now,access::until(FAMILY_SECONDS)?])?;
            tx.execute("INSERT INTO mcp_codes(token_hash,authorization_id,grant_id,issued_at,expires_at) VALUES(?1,?2,?3,?4,?5)",params![hash,id,grant,now,access::until(120)?])?;
            audit::mutation(tx,&actor,"mcp_grant",&grant,client.as_deref(),"created",(None,audit::Snapshot{exists:Some(true),..Default::default()}))?;
            url.query_pairs_mut().append_pair("code",&code);
        }else{url.query_pairs_mut().append_pair("error","access_denied");}
        if !state.is_empty(){url.query_pairs_mut().append_pair("state",&state);}
        url.query_pairs_mut().append_pair("iss",&issuer);
        Ok(json!({"redirect_url":url.as_str()}))
    }).await
}

fn issue(
    tx: &Transaction<'_>,
    grant: &str,
    scopes: &BTreeSet<String>,
    expiry: &str,
) -> Result<Value> {
    let (access, access_hash) = access::opaque();
    let (refresh, refresh_hash) = access::opaque();
    let now = validation::now();
    let access_until = std::cmp::min(access::until(ACCESS_SECONDS)?, expiry.to_owned());
    tx.execute("INSERT INTO mcp_access_tokens(token_hash,grant_id,scopes,issued_at,expires_at) VALUES(?1,?2,?3,?4,?5)",params![access_hash,grant,access::scope_text(scopes),now,access_until])?;
    tx.execute("INSERT INTO mcp_refresh_tokens(token_hash,grant_id,issued_at,expires_at) VALUES(?1,?2,?3,?4)",params![refresh_hash,grant,now,expiry])?;
    let seconds = chrono::DateTime::parse_from_rfc3339(&access_until)
        .map_err(|_| Error::Internal)?
        .signed_duration_since(
            chrono::DateTime::parse_from_rfc3339(&now).map_err(|_| Error::Internal)?,
        )
        .num_seconds()
        .clamp(1, ACCESS_SECONDS);
    maintain(tx)?;
    security_event(tx, grant, "mcp_credentials", "created")?;
    Ok(
        json!({"access_token":access,"token_type":"Bearer","expires_in":seconds,"refresh_token":refresh,"scope":access::scope_text(scopes)}),
    )
}
fn revoke_grant(tx: &Transaction<'_>, grant: &str) -> Result<()> {
    let changed = tx.execute(
        "UPDATE mcp_grants SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL",
        params![validation::now(), grant],
    )?;
    if changed > 0 {
        security_event(tx, grant, "mcp_grant", "archived")?;
    }
    Ok(())
}

pub async fn token(db: &Database, config: &Config, q: Query) -> Result<Value> {
    let app =
        validation::id(required(&q, "client_id")?).map_err(|_| Error::Invalid("invalid_client"))?;
    if required(&q, "resource")? != resource(config) {
        return Err(Error::Invalid("invalid_target"));
    }
    let kind = required(&q, "grant_type")?.to_owned();
    let audience = resource(config);
    if !["authorization_code", "refresh_token"].contains(&kind.as_str()) {
        return Err(Error::Invalid("unsupported_grant_type"));
    }
    let raw = required(
        &q,
        if kind == "authorization_code" {
            "code"
        } else {
            "refresh_token"
        },
    )?;
    let hash = access::token_hash(raw).map_err(|_| Error::Invalid("invalid_grant"))?;
    let redirect = q.get("redirect_uri").unwrap_or("").to_owned();
    let verifier = q.get("code_verifier").unwrap_or("").to_owned();
    let requested = q.get("scope").map(access::scopes).transpose()?;
    if kind == "authorization_code"
        && (!(43..=128).contains(&verifier.len())
            || !verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b)))
    {
        return Err(Error::Invalid("invalid_grant"));
    }
    let result=db.write(move|tx|{
        access::enabled(tx)?;application(tx,&app)?;
        let row:Option<(String,String,String,String,Option<String>)>=if kind=="authorization_code"{
            let r:Option<CodeRecord>=tx.query_row("SELECT g.id,g.user_id,g.scopes,g.expires_at,c.consumed_at,r.redirect_uri,r.challenge FROM mcp_codes c JOIN mcp_authorizations r ON r.id=c.authorization_id JOIN mcp_grants g ON g.id=c.grant_id WHERE c.token_hash=?1 AND g.application_id=?2 AND g.resource=?3",params![hash,app,audience],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
            if let Some((grant,user,scopes,expiry,consumed,registered,challenge))=r {
                let actual=PkceCodeChallenge::from_code_verifier_sha256(&PkceCodeVerifier::new(verifier));
                if registered!=redirect || actual.as_str().as_bytes().ct_eq(challenge.as_bytes()).unwrap_u8()!=1{return Err(Error::Invalid("invalid_grant"));}
                Some((grant,user,scopes,expiry,consumed))
            }else{None}
        }else{
            tx.query_row("SELECT g.id,g.user_id,g.scopes,g.expires_at,r.consumed_at FROM mcp_refresh_tokens r JOIN mcp_grants g ON g.id=r.grant_id WHERE r.token_hash=?1 AND g.application_id=?2 AND g.resource=?3",params![hash,app,audience],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?
        };
        let (grant,user,original,expiry,consumed)=row.ok_or(Error::Invalid("invalid_grant"))?;
        access::grant_active(tx,&user,&grant).map_err(|_|Error::Invalid("invalid_grant"))?;
        if consumed.is_some(){revoke_grant(tx,&grant)?;security_event(tx,&grant,"mcp_replay","created")?;return Ok(None);}
        let table=if kind=="authorization_code"{"mcp_codes"}else{"mcp_refresh_tokens"};
        let valid:bool=tx.query_row(&format!("SELECT expires_at>?2 FROM {table} WHERE token_hash=?1"),params![hash,validation::now()],|r|r.get(0))?;
        if !valid{return Err(Error::Invalid("invalid_grant"));}
        let original=access::scopes(&original)?;let selected=requested.unwrap_or_else(||original.clone());
        if !selected.is_subset(&original){return Err(Error::Invalid("invalid_scope"));}
        tx.execute(&format!("UPDATE {table} SET consumed_at=?1 WHERE token_hash=?2 AND consumed_at IS NULL"),params![validation::now(),hash])?;
        // Old access credentials expire naturally; refresh replay revokes their common grant immediately.
        issue(tx,&grant,&selected,&expiry).map(Some)
    }).await?;
    result.ok_or(Error::Invalid("invalid_grant"))
}

pub async fn revoke(db: &Database, q: Query) -> Result<()> {
    let app =
        validation::id(required(&q, "client_id")?).map_err(|_| Error::Invalid("invalid_client"))?;
    let hash = access::token_hash(required(&q, "token")?).ok();
    db.write(move|tx|{
        application(tx,&app)?;
        if let Some(hash)=hash {
            let grant:Option<String>=tx.query_row("SELECT g.id FROM mcp_grants g WHERE g.application_id=?1 AND (EXISTS(SELECT 1 FROM mcp_access_tokens t WHERE t.grant_id=g.id AND t.token_hash=?2) OR EXISTS(SELECT 1 FROM mcp_refresh_tokens t WHERE t.grant_id=g.id AND t.token_hash=?2))",params![app,hash],|r|r.get(0)).optional()?;
            if let Some(grant)=grant{revoke_grant(tx,&grant)?;}
        } Ok(())
    }).await
}

fn security_event(tx: &Transaction<'_>, grant: &str, kind: &str, action: &str) -> Result<()> {
    let client: Option<String> = tx.query_row(
        "SELECT client_id FROM mcp_grants WHERE id=?1",
        [grant],
        |r| r.get(0),
    )?;
    audit::append(
        tx,
        audit::Event {
            actor: None,
            request_id: &audit::request_id(),
            kind,
            id: grant,
            client: client.as_deref(),
            action,
            before: None,
            after: Some(audit::Snapshot {
                exists: Some(action != "archived"),
                ..Default::default()
            }),
            source: "mcp",
        },
    )
}

fn maintain(tx: &Transaction<'_>) -> Result<()> {
    let now = validation::now();
    tx.execute("DELETE FROM mcp_access_tokens WHERE token_hash IN (SELECT token_hash FROM mcp_access_tokens WHERE expires_at<=?1 ORDER BY expires_at,token_hash LIMIT 128)",[&now])?;
    tx.execute("DELETE FROM mcp_refresh_tokens WHERE token_hash IN (SELECT token_hash FROM mcp_refresh_tokens WHERE expires_at<=?1 ORDER BY expires_at,token_hash LIMIT 128)",[&now])?;
    tx.execute("DELETE FROM mcp_codes WHERE token_hash IN (SELECT c.token_hash FROM mcp_codes c JOIN mcp_grants g ON g.id=c.grant_id WHERE g.expires_at<=?1 LIMIT 128)",[&now])?;
    tx.execute("DELETE FROM mcp_authorizations WHERE id IN (SELECT id FROM mcp_authorizations a WHERE expires_at<=?1 AND NOT EXISTS(SELECT 1 FROM mcp_codes c WHERE c.authorization_id=a.id) ORDER BY expires_at,id LIMIT 128)",[&now])?;
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(30))
        .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
    tx.execute("DELETE FROM mcp_approvals WHERE id IN (SELECT id FROM mcp_approvals WHERE expires_at<=?1 ORDER BY expires_at,id LIMIT 128)",[cutoff])?;
    Ok(())
}
