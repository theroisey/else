//! Durable command identity and browser-only, exact-payload approvals.
use super::access;
use crate::{
    audit,
    db::Database,
    error::{Error, Result},
    security::{self, Actor},
    validation,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn receipt(tx: &Transaction<'_>, actor: &Actor) -> Result<Option<Value>> {
    let d = actor.delegation().ok_or(Error::Denied)?;
    let c = actor.command().ok_or(Error::Internal)?;
    let row:Option<(String,String,String,Option<String>,String,String)>=tx.query_row("SELECT tool_name,argument_digest,resource_id,revision,request_id,resource_kind FROM mcp_commands WHERE user_id=?1 AND application_id=?2 AND command_id=?3",params![actor.user_id,d.application_id,c.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    row.map(|(tool, digest, id, revision, request_id, resource_kind)| {
        if tool != c.tool || digest != c.digest {
            return Err(Error::Conflict("command_conflict"));
        }
        super::output::value(super::output::Mutation::Committed {
            command_id: c.id.clone(),
            id,
            resource_kind,
            revision,
            request_id,
        })
    })
    .transpose()
}
/// Runs in the domain's IMMEDIATE transaction, before its safe audit is appended.
pub fn commit(tx: &Transaction<'_>, event: &audit::Event<'_>) -> Result<()> {
    let Some(actor) = event.actor else {
        return Ok(());
    };
    let Some(c) = actor.command() else {
        return Ok(());
    };
    if c.kind != event.kind {
        return Ok(());
    }
    security::fresh(tx, actor)?;
    if receipt(tx, actor)?.is_some() {
        let d = actor.delegation().ok_or(Error::Internal)?;
        let same:bool=tx.query_row("SELECT transaction_token=transaction_token() FROM mcp_commands WHERE user_id=?1 AND application_id=?2 AND command_id=?3",params![actor.user_id,d.application_id,c.id],|r|r.get(0))?;
        if same {
            return Ok(());
        }
        return Err(Error::Conflict("command_committed"));
    }
    let d = actor.delegation().ok_or(Error::Internal)?;
    if c.high_impact {
        let approval = c.approval_id.as_deref().ok_or(Error::Denied)?;
        let changed=tx.execute("UPDATE mcp_approvals SET consumed_at=?1 WHERE id=?2 AND user_id=?3 AND application_id=?4 AND grant_id=?5 AND command_id=?6 AND tool_name=?7 AND argument_digest=?8 AND state='approved' AND consumed_at IS NULL AND expires_at>?1",params![validation::now(),approval,actor.user_id,d.application_id,d.grant_id,c.id,c.tool,c.digest])?;
        if changed != 1 {
            return Err(Error::Denied);
        }
    }
    tx.execute("INSERT INTO mcp_commands(user_id,application_id,command_id,grant_id,tool_name,argument_digest,resource_kind,resource_id,revision,request_id,committed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![actor.user_id,d.application_id,c.id,d.grant_id,c.tool,c.digest,event.kind,event.id,event.after.as_ref().and_then(|s|s.revision).map(|s|s.to_string()),actor.request_id,validation::now()])?;
    Ok(())
}
/// Reuse a pending intent on retries; approval is never accepted from an MCP argument alone.
pub async fn prepare(
    db: &Database,
    actor: Actor,
    arguments: Value,
    client: Option<String>,
) -> Result<Value> {
    db.write(move|tx|{
  security::fresh(tx,&actor)?;let d=actor.delegation().ok_or(Error::Denied)?;let c=actor.command().ok_or(Error::Internal)?;
  let old:Option<(String,String,String,String)>=tx.query_row("SELECT id,argument_digest,state,expires_at FROM mcp_approvals WHERE user_id=?1 AND application_id=?2 AND command_id=?3 ORDER BY created_at DESC LIMIT 1",params![actor.user_id,d.application_id,c.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
  if let Some((id,digest,state,expires))=old {
   if digest!=c.digest{return Err(Error::Conflict("command_conflict"));}
   if expires>validation::now(){return super::output::value(super::output::Mutation::ApprovalRequired{review_path:format!("/app/mcp/approvals/{id}"),approval_id:id,approval_state:state,command_id:c.id.clone()});}
  }
  let count:i64=tx.query_row("SELECT count(*) FROM mcp_approvals WHERE user_id=?1 AND state='pending' AND expires_at>?2",params![actor.user_id,validation::now()],|r|r.get(0))?;if count>=64{return Err(Error::Busy)}
  let id=validation::new_id();let raw=serde_json::to_string(&arguments).map_err(|_|Error::Internal)?;if raw.len()>49152{return Err(Error::Invalid("invalid_arguments"));}
  tx.execute("INSERT INTO mcp_approvals(id,user_id,application_id,grant_id,command_id,tool_name,argument_digest,arguments,client_id,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![id,actor.user_id,d.application_id,d.grant_id,c.id,c.tool,c.digest,raw,client,validation::now(),access::until(600)?])?;
  audit::mutation(tx,&actor,"mcp_approval",&id,client.as_deref(),"created",(None,audit::Snapshot::revision(1)))?;
  super::output::value(super::output::Mutation::ApprovalRequired{review_path:format!("/app/mcp/approvals/{id}"),approval_id:id,approval_state:"pending".into(),command_id:c.id.clone()})
 }).await
}
pub async fn inspect(db: &Database, actor: Actor, id: String) -> Result<Value> {
    db.read(move|tx|{
  security::fresh(tx,&actor)?;if actor.delegation().is_some(){return Err(Error::Denied)}
  let (tool,client,grant):(String,Option<String>,String)=tx.query_row("SELECT tool_name,client_id,grant_id FROM mcp_approvals WHERE id=?1 AND user_id=?2",params![id,actor.user_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
  authorize_review(tx,&actor,&tool,client.as_deref(),&grant)?;
  let row:Value=tx.query_row("SELECT p.id,p.tool_name,p.arguments AS arguments_json,p.argument_digest,p.command_id,p.client_id,p.state,p.expires_at,p.consumed_at,a.name AS application_name FROM mcp_approvals p JOIN mcp_applications a ON a.id=p.application_id WHERE p.id=?1 AND p.user_id=?2",params![id,actor.user_id],crate::query::row_json)?;
  Ok(row)
 }).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub approve: bool,
    pub argument_digest: String,
}
pub async fn decide(db: &Database, actor: Actor, id: String, input: Decision) -> Result<Value> {
    db.write(move|tx|{
  security::fresh(tx,&actor)?;if actor.delegation().is_some(){return Err(Error::Denied)}
  let (digest,grant,client,tool):(String,String,Option<String>,String)=tx.query_row("SELECT argument_digest,grant_id,client_id,tool_name FROM mcp_approvals WHERE id=?1 AND user_id=?2 AND state='pending' AND expires_at>?3",params![id,actor.user_id,validation::now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
  authorize_review(tx,&actor,&tool,client.as_deref(),&grant)?;
  if input.argument_digest!=digest{return Err(Error::Conflict("conflict"));}
  let state=if input.approve{"approved"}else{"denied"};
  tx.execute("UPDATE mcp_approvals SET state=?1,decided_at=?2 WHERE id=?3",params![state,validation::now(),id])?;
  audit::mutation(tx,&actor,"mcp_approval",&id,client.as_deref(),"updated",(Some(audit::Snapshot::revision(1)),audit::Snapshot::revision(2)))?;
  Ok(json!({"id":id,"state":state}))
 }).await
}

fn authorize_review(
    tx: &Transaction<'_>,
    actor: &Actor,
    tool: &str,
    client: Option<&str>,
    grant: &str,
) -> Result<()> {
    access::grant_active(tx, &actor.user_id, grant)?;
    let d = super::registry::definitions()
        .iter()
        .find(|d| d.name == tool && d.high)
        .ok_or(Error::NotFound)?;
    let mut allowed = false;
    for key in d.permissions.split('|') {
        allowed |= security::allowed_actor(tx, actor, key, client)?;
    }
    if !allowed {
        return Err(Error::Denied);
    }
    if d.scope == "finance:write" {
        let c = client.ok_or(Error::Denied)?;
        if d.name.starts_with("else_pricing_") {
            security::require(tx, actor, "pricing.view", Some(c))?;
            if d.name == "else_pricing_copy" {
                security::require(tx, actor, "billing.view", Some(c))?;
            }
        } else {
            security::require(tx, actor, "billing.view", Some(c))?;
            if d.name.starts_with("else_agreements_") || d.name.starts_with("else_periods_") {
                security::require(tx, actor, "agreements.view", Some(c))?;
                security::require(tx, actor, "clients.view", Some(c))?;
            }
        }
    }
    Ok(())
}

/// Called only by a request-local guarded database, before committing changed SQL.
pub(crate) fn verify_commit(tx: &Transaction<'_>, actor: &Actor) -> Result<()> {
    let d = actor.delegation().ok_or(Error::Internal)?;
    let c = actor.command().ok_or(Error::Internal)?;
    let proof:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM mcp_commands c WHERE c.user_id=?1 AND c.application_id=?2 AND c.command_id=?3 AND c.tool_name=?4 AND c.argument_digest=?5 AND c.transaction_token=transaction_token() AND EXISTS(SELECT 1 FROM audit_events e WHERE e.request_id=c.request_id AND e.actor_user_id=c.user_id AND e.resource_kind=c.resource_kind AND e.resource_id=c.resource_id AND json_extract(e.metadata,'$.source')='mcp'))",params![actor.user_id,d.application_id,c.id,c.tool,c.digest],|r|r.get(0))?;
    if proof { Ok(()) } else { Err(Error::Internal) }
}
