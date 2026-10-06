//! A bounded attention view from one SQLite snapshot, with absent unauthorized
//! sections rather than fabricated zero values or partial cross-client totals.
use crate::{
    activity, billing,
    db::Database,
    error::{Error, Result},
    query::row_json,
    security::{self, Actor},
    validation,
};
use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use rusqlite::{Transaction, params};
use serde_json::Value;

fn queue(mut items: Vec<Value>) -> Value {
    let more = items.len() > 5;
    items.truncate(5);
    serde_json::json!({"items":items,"has_more":more})
}
fn attention(
    tx: &Transaction<'_>,
    sql: &str,
    client: &str,
    from: Option<&str>,
    until: &str,
) -> Result<Value> {
    let mut statement = tx.prepare(sql)?;
    let items = statement
        .query_map(params![client, from, until], row_json)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(queue(items))
}

pub async fn read(db: &Database, actor: Actor, client: String) -> Result<Value> {
    db.read(move|tx| {
        security::fresh(tx,&actor)?;
        if !security::allowed_user(tx,&actor.user_id,"clients.view",Some(&client))? {return Err(Error::NotFound);}
        let profile=tx.query_row("SELECT id,name,CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS status,archived_at FROM clients WHERE id=?1",[&client],row_json)?;
        let now=validation::now();
        let horizon=DateTime::parse_from_rfc3339(&now).map_err(|_|Error::Internal)?.with_timezone(&Utc).checked_add_signed(TimeDelta::hours(168)).ok_or(Error::Internal)?.to_rfc3339_opts(SecondsFormat::Micros,true);
        let mut view=serde_json::json!({"client":profile,"as_of":now,"horizon_end":horizon});
        if security::allowed_user(tx,&actor.user_id,"billing.view",Some(&client))? {
            view["finance"]=serde_json::json!({"currencies":billing::summary_at(tx,&client,&now[..10])?});
        }
        if security::allowed_user(tx,&actor.user_id,"tasks.view",Some(&client))? {
            const SQL:&str="SELECT id,title,status,priority,due_at FROM tasks WHERE client_id=?1 AND archived_at IS NULL AND status NOT IN ('done','cancelled') AND due_at<=?3 AND (?2 IS NULL OR due_at>?2) ORDER BY due_at,id LIMIT 6";
            view["tasks"]=serde_json::json!({"overdue":attention(tx,SQL,&client,None,&now)?,"due_soon":attention(tx,SQL,&client,Some(&now),&horizon)?});
        }
        if security::allowed_user(tx,&actor.user_id,"reminders.view",Some(&client))? {
            const SQL:&str="SELECT id,title,scheduled_at,timezone FROM reminders WHERE client_id=?1 AND status='pending' AND scheduled_at<=?3 AND (?2 IS NULL OR scheduled_at>?2) ORDER BY scheduled_at,id LIMIT 6";
            view["reminders"]=serde_json::json!({"due":attention(tx,SQL,&client,None,&now)?,"upcoming":attention(tx,SQL,&client,Some(&now),&horizon)?});
        }
        if security::allowed_user(tx,&actor.user_id,"activity.view",Some(&client))? {
            view["activity"]=queue(activity::project(tx,&actor,&client,None,6)?);
        }
        Ok(view)
    }).await
}
