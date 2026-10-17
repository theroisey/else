//! Existing browser-session/Origin/CSRF transport is the authority for management and consent.
use super::{access, oauth};
use crate::{
    api::{Reply, Request},
    audit,
    config::Config,
    db::Database,
    error::{Error, Result},
    query::{Query, row_json},
    security::{self, Actor},
    validation,
};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const SETTINGS_ID: &str = "00000000-0000-4000-8000-000000000008";
pub async fn status(db: &Database, config: &Config, actor: Actor) -> Result<Value> {
    let endpoint = oauth::resource(config);
    db.read(move|tx|{
        security::fresh(tx,&actor)?;
        let can=security::allowed_actor(tx,&actor,"mcp.manage",None)?;
        let (enabled,revision):(bool,i64)=tx.query_row("SELECT enabled,revision FROM mcp_settings WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        Ok(json!({"enabled":enabled,"revision":revision.to_string(),"endpoint":endpoint,"can_manage":can,"scopes":access::SCOPES}))
    }).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub expected_revision: String,
}
pub async fn settings(db: &Database, actor: Actor, input: Settings) -> Result<Value> {
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    db.write(move|tx|{
        security::require(tx,&actor,"mcp.manage",None)?;
        let (enabled,revision):(bool,i64)=tx.query_row("SELECT enabled,revision FROM mcp_settings WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let next=crate::query::next_revision(revision,expected)?;let now=validation::now();
        if !input.enabled {
            tx.execute("UPDATE mcp_grants SET revoked_at=?1 WHERE revoked_at IS NULL",[&now])?;
            tx.execute("UPDATE mcp_authorizations SET consumed_at=?1 WHERE consumed_at IS NULL",[&now])?;
            tx.execute("UPDATE mcp_approvals SET state='revoked',decided_at=?1 WHERE state='pending'",[&now])?;
        }
        tx.execute("UPDATE mcp_settings SET enabled=?1,revision=?2,updated_at=?3 WHERE id=1",params![input.enabled,next,now])?;
        audit::mutation(tx,&actor,"mcp_settings",SETTINGS_ID,None,"updated",(Some(audit::Snapshot::revision(revision)),audit::Snapshot::revision(next)))?;
        Ok(json!({"enabled":input.enabled,"revision":next.to_string(),"previously_enabled":enabled}))
    }).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Application {
    pub name: String,
    pub redirect_uris: Vec<String>,
    #[serde(default)]
    pub origins: Vec<String>,
}
pub async fn register(db: &Database, actor: Actor, input: Application) -> Result<Value> {
    let name = validation::text(&input.name, 120, true, false)?;
    if !(1..=8).contains(&input.redirect_uris.len()) || input.origins.len() > 4 {
        return Err(Error::Invalid("invalid_request"));
    }
    let uris = input
        .redirect_uris
        .iter()
        .map(|s| oauth::redirect(s))
        .collect::<Result<BTreeSet<_>>>()?;
    if uris.len() != input.redirect_uris.len() {
        return Err(Error::Invalid("invalid_request"));
    }
    let mut origins = BTreeSet::new();
    for origin in input.origins {
        let url = url::Url::parse(&origin).map_err(|_| Error::Invalid("invalid_request"))?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if origin.len() > 512
            || url.origin().ascii_serialization() != origin
            || !(url.scheme() == "https" || (local && url.scheme() == "http"))
            || !url.username().is_empty()
            || url.password().is_some()
            || !origins.insert(origin)
        {
            return Err(Error::Invalid("invalid_request"));
        }
    }
    db.write(move|tx|{
        security::require(tx,&actor,"mcp.manage",None)?;
        let count:i64=tx.query_row("SELECT count(*) FROM mcp_applications WHERE revoked_at IS NULL",[],|r|r.get(0))?;
        if count>=64{return Err(Error::Busy);}
        let id=validation::new_id();let now=validation::now();
        tx.execute("INSERT INTO mcp_applications(id,name,created_by,created_at) VALUES(?1,?2,?3,?4)",params![id,name,actor.user_id,now])?;
        for uri in &uris {tx.execute("INSERT INTO mcp_redirects VALUES(?1,?2)",params![id,uri])?;}
        for origin in &origins {tx.execute("INSERT INTO mcp_origins VALUES(?1,?2)",params![id,origin])?;}
        audit::mutation(tx,&actor,"mcp_application",&id,None,"created",(None,audit::Snapshot::revision(1)))?;
        Ok(json!({"id":id,"name":name,"redirect_uris":uris,"origins":origins,"revision":"1","created_at":now,"revoked_at":null}))
    }).await
}
pub async fn applications(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let page = q.paging()?;
    db.read(move|tx|{
        security::require(tx,&actor,"mcp.manage",None)?;
        let mut stmt=tx.prepare("SELECT a.id,a.name,CAST(a.revision AS TEXT) AS revision,a.created_at,a.revoked_at,(SELECT json_group_array(uri) FROM (SELECT uri FROM mcp_redirects WHERE application_id=a.id ORDER BY uri)) AS redirect_uris_json,(SELECT json_group_array(origin) FROM (SELECT origin FROM mcp_origins WHERE application_id=a.id ORDER BY origin)) AS origins_json FROM mcp_applications a WHERE (?1 IS NULL OR a.id>?1) ORDER BY a.id LIMIT ?2")?;
        page.page(stmt.query_map(params![page.cursor,(page.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}
pub async fn grants(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let page = q.paging()?;
    db.read(move|tx|{
        security::fresh(tx,&actor)?;
        let mut stmt=tx.prepare("SELECT g.id,g.application_id,a.name AS application_name,g.client_id,g.scopes,g.created_at,g.expires_at,g.revoked_at FROM mcp_grants g JOIN mcp_applications a ON a.id=g.application_id WHERE g.user_id=?1 AND (?2 IS NULL OR g.id>?2) ORDER BY g.id LIMIT ?3")?;
        page.page(stmt.query_map(params![actor.user_id,page.cursor,(page.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}
pub async fn revoke_application(
    db: &Database,
    actor: Actor,
    id: String,
    revision: String,
) -> Result<Value> {
    let expected = validation::exact_integer(&revision, true)?;
    db.write(move |tx| {
        security::require(tx, &actor, "mcp.manage", None)?;
        let current: Option<i64> = tx
            .query_row(
                "SELECT revision FROM mcp_applications WHERE id=?1 AND revoked_at IS NULL",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        let old = current.ok_or(Error::NotFound)?;
        let next = crate::query::next_revision(old, expected)?;
        let now = validation::now();
        tx.execute(
            "UPDATE mcp_applications SET revoked_at=?1,revision=?2 WHERE id=?3",
            params![now, next, id],
        )?;
        tx.execute(
            "UPDATE mcp_grants SET revoked_at=?1 WHERE application_id=?2 AND revoked_at IS NULL",
            params![now, id],
        )?;
        audit::mutation(
            tx,
            &actor,
            "mcp_application",
            &id,
            None,
            "updated",
            (
                Some(audit::Snapshot::revision(old)),
                audit::Snapshot::revision(next),
            ),
        )?;
        Ok(json!({"id":id,"revision":next.to_string()}))
    })
    .await
}
pub async fn revoke_grant(db: &Database, actor: Actor, id: String) -> Result<Value> {
    db.write(move |tx| {
        security::fresh(tx, &actor)?;
        let owner: Option<(String, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT user_id,client_id,revoked_at FROM mcp_grants WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (user, client, revoked) = owner.ok_or(Error::NotFound)?;
        if user != actor.user_id && !security::allowed_actor(tx, &actor, "mcp.manage", None)? {
            return Err(Error::NotFound);
        }
        if revoked.is_none() {
            tx.execute(
                "UPDATE mcp_grants SET revoked_at=?1 WHERE id=?2",
                params![validation::now(), id],
            )?;
            audit::mutation(
                tx,
                &actor,
                "mcp_grant",
                &id,
                client.as_deref(),
                "updated",
                (
                    Some(audit::Snapshot {
                        exists: Some(true),
                        ..Default::default()
                    }),
                    audit::Snapshot {
                        exists: Some(false),
                        ..Default::default()
                    },
                ),
            )?;
        }
        Ok(json!({"id":id,"revoked":true}))
    })
    .await
}
pub async fn dispatch(
    db: &Database,
    config: &Config,
    actor: Actor,
    route: &[&str],
    r: &Request,
) -> Result<Reply> {
    let method = r.method.as_str();
    if (method == "GET" && !r.body.is_empty())
        || (method != "GET" && r.query_present)
        || !r.query.is_empty() && !matches!(route, ["applications"] | ["grants"])
    {
        return Err(Error::Invalid("invalid_request"));
    }
    let result = match (route, method) {
        ([], "GET") => status(db, config, actor).await?,
        (["metrics"], "GET") => {
            db.read(move |tx| security::require(tx, &actor, "mcp.manage", None))
                .await?;
            super::metrics::read()
        }
        (["settings"], "PUT") => settings(db, actor, validation::json(&r.body)?).await?,
        (["applications"], "GET") => {
            return Ok(Reply::page(
                applications(db, actor, Query::parse(&r.query, &["limit", "cursor"])?).await?,
            ));
        }
        (["applications"], "POST") => register(db, actor, validation::json(&r.body)?).await?,
        (["applications", id, "revoke"], "POST") => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Input {
                expected_revision: String,
            }
            let input: Input = validation::json(&r.body)?;
            revoke_application(db, actor, validation::id(id)?, input.expected_revision).await?
        }
        (["grants"], "GET") => {
            return Ok(Reply::page(
                grants(db, actor, Query::parse(&r.query, &["limit", "cursor"])?).await?,
            ));
        }
        (["grants", id, "revoke"], "POST") => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Empty {}
            let _: Empty = validation::json(&r.body)?;
            revoke_grant(db, actor, validation::id(id)?).await?
        }
        (["approvals", id], "GET") => {
            super::commands::inspect(db, actor, validation::id(id)?).await?
        }
        (["approvals", id], "POST") => {
            super::commands::decide(db, actor, validation::id(id)?, validation::json(&r.body)?)
                .await?
        }
        (["authorizations", id], "GET") => oauth::pending(db, actor, validation::id(id)?).await?,
        (["authorizations", id], "POST") => {
            oauth::consent(
                db,
                config,
                actor,
                validation::id(id)?,
                validation::json(&r.body)?,
            )
            .await?
        }
        _ => return Err(Error::NotFound),
    };
    Reply::data(200, result)
}
