//! Seven-field metadata and local fencing; no request performs provider I/O.
use crate::{
    audit::{self, Snapshot},
    db::Database,
    error::{Error, Result},
    history_cursor, integration_catalog,
    query::{Query, row_json},
    security::{self, Actor},
    validation,
    vault::Scope,
    websites,
};
use rusqlite::{Transaction, params};
use serde::Deserialize;
use serde_json::Value;
const COLUMNS: &str =
    "id,client_id,provider,state,CAST(revision AS TEXT) AS revision,created_at,updated_at";

pub(crate) fn authorize(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    permission: &str,
    writing: bool,
) -> Result<()> {
    security::fresh(tx, actor)?;
    if !security::allowed_user(tx, &actor.user_id, "clients.view", Some(client))?
        || !security::allowed_user(tx, &actor.user_id, permission, Some(client))?
    {
        return Err(Error::NotFound);
    }
    security::client(tx, client, false)?;
    if writing {
        let active: bool = tx.query_row(
            "SELECT archived_at IS NULL FROM clients WHERE id=?1",
            [client],
            |r| r.get(0),
        )?;
        if !active {
            return Err(Error::NotFound);
        }
    }
    Ok(())
}
pub(crate) fn document(tx: &Transaction<'_>, client: &str, id: &str) -> Result<Value> {
    Ok(tx.query_row(
        &format!("SELECT {COLUMNS} FROM integration_connections WHERE client_id=?1 AND id=?2"),
        params![client, id],
        row_json,
    )?)
}
pub async fn list(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let limit = history_cursor::limit(query.get("limit"))?;
    let cursor = history_cursor::id_decode(&client, query.get("cursor"))?;
    db.read(move|tx| {
        authorize(tx,&actor,&client,"integrations.view",false)?;
        let mut stmt=tx.prepare(&format!("SELECT {COLUMNS} FROM integration_connections WHERE client_id=?1 AND (?2 IS NULL OR id>?2) ORDER BY id LIMIT ?3"))?;
        let mut data=stmt.query_map(params![client,cursor,(limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=data.len()>limit;data.truncate(limit);
        let next=if more{Some(history_cursor::id_encode(&client,data.last().ok_or(Error::Internal)?["id"].as_str().ok_or(Error::Internal)?))}else{None};
        Ok(serde_json::json!({"data":data,"page":{"limit":limit,"next_cursor":next}}))
    }).await
}
pub async fn read(db: &Database, actor: Actor, scope: Scope) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &scope.client, "integrations.view", false)?;
        if let Some(website) = &scope.website {
            websites::check_binding(tx, &actor, &scope.client, website, &scope.connection, false)?;
        }
        document(tx, &scope.client, &scope.connection)
    })
    .await
}
pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    provider: String,
    account: String,
) -> Result<Value> {
    if !integration_catalog::valid_account(&provider, &account)
        || (provider == "meta_ads" && account.len() > 20)
    {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move |tx| {
        authorize(tx, &actor, &client, "integrations.manage", true)?;
        let id = validation::new_id();
        let now = validation::now();
        tx.execute(
            "INSERT INTO integration_connections VALUES (?1,?2,?3,?4,'pending',1,1,?5,?5)",
            params![id, client, provider, account, now],
        )?;
        audit::mutation(
            tx,
            &actor,
            "integration_connection",
            &id,
            Some(&client),
            "created",
            (
                Some(Snapshot {
                    exists: Some(false),
                    ..Default::default()
                }),
                Snapshot::revision(1),
            ),
        )?;
        document(tx, &client, &id)
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Disconnect {
    revision: String,
    confirmed: bool,
}
pub async fn disconnect(
    db: &Database,
    actor: Actor,
    scope: Scope,
    input: Disconnect,
) -> Result<Value> {
    let expected = validation::exact_integer(&input.revision, true)?;
    if !input.confirmed {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move|tx| {
        authorize(tx,&actor,&scope.client,"integrations.view",true)?;
        authorize(tx,&actor,&scope.client,"integrations.manage",true)?;
        if let Some(website)=&scope.website {websites::check_binding(tx,&actor,&scope.client,website,&scope.connection,true)?;}
        let (previous,generation,state):(i64,i64,String)=tx.query_row("SELECT revision,generation,state FROM integration_connections WHERE id=?1 AND client_id=?2",params![scope.connection,scope.client],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if expected!=previous||state=="disconnected" {return Err(Error::Conflict("conflict"));}
        if state!="revocation_failed" {
            let next=previous.checked_add(1).ok_or(Error::Conflict("conflict"))?;let generation=generation.checked_add(1).ok_or(Error::Conflict("conflict"))?;
            tx.execute("UPDATE integration_connections SET state='revocation_failed',revision=?1,generation=?2,updated_at=?3 WHERE id=?4",params![next,generation,validation::now(),scope.connection])?;
            audit::mutation(tx,&actor,"integration_connection",&scope.connection,Some(&scope.client),"updated",(Some(Snapshot::revision(previous)),Snapshot::revision(next)))?;
        }
        Ok(serde_json::json!({"data":document(tx,&scope.client,&scope.connection)?,"revocation":{"status":"unavailable","manual_action_required":true}}))
    }).await
}
