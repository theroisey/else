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
        let mut task_read=false;
        for key in crate::tasks::READ_KEYS { task_read |= security::allowed_user(tx,&actor.user_id,key,Some(&client))?; }
        if task_read {
            let sql=format!("SELECT t.id,t.title,t.status,t.priority,t.due_at FROM tasks t WHERE t.client_id=?1 AND {} AND t.archived_at IS NULL AND t.status NOT IN ('done','cancelled') AND t.due_at<=?3 AND (?2 IS NULL OR t.due_at>?2) ORDER BY t.due_at,t.id LIMIT 6",crate::tasks::visibility_sql("?4"));
            let read=|from:Option<&str>,until:&str|->Result<Value>{let mut stmt=tx.prepare(&sql)?;Ok(queue(stmt.query_map(params![client,from,until,actor.user_id],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?))};
            view["tasks"]=serde_json::json!({"overdue":read(None,&now)?,"due_soon":read(Some(&now),&horizon)?});
        }
        let mut request_read=false;
        for key in ["tickets.read_all","tickets.read_team","tickets.read_own"]{request_read|=security::allowed_user(tx,&actor.user_id,key,Some(&client))?;}
        if request_read {
            let visible=crate::operations::requests::visibility_sql("?1");
            let mut counts:std::collections::BTreeMap<String,String>=crate::operations::requests::STATES.iter().map(|v|(v.to_string(),"0".into())).collect();
            let mut stmt=tx.prepare(&format!("SELECT r.status,count(*) FROM technical_requests r WHERE {visible} AND r.client_id=?2 GROUP BY r.status"))?;
            let mut rows=stmt.query(params![actor.user_id,client])?;while let Some(row)=rows.next()?{counts.insert(row.get(0)?,row.get::<_,i64>(1)?.to_string());}
            let mut stmt=tx.prepare(&format!("SELECT r.id,r.client_id,r.title,r.status,u.display_name AS requester_name,r.updated_at FROM technical_requests r JOIN users u ON u.id=r.created_by WHERE {visible} AND r.client_id=?2 ORDER BY r.updated_at DESC,r.id DESC LIMIT 6"))?;
            let requests=queue(stmt.query_map(params![actor.user_id,client],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?);
            let mut stmt=tx.prepare("SELECT b.id,b.client_id,u.display_name,t.name AS team_name,b.responsibility FROM brand_staff_assignments b JOIN users u ON u.id=b.user_id JOIN teams t ON t.id=b.team_id WHERE b.client_id=?1 AND b.revoked_at IS NULL AND u.status='active' AND t.archived_at IS NULL ORDER BY b.id LIMIT 6")?;
            let staff=queue(stmt.query_map([&client],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?);
            let mut stmt=tx.prepare("SELECT id,client_id,name,domain FROM client_websites WHERE client_id=?1 AND archived_at IS NULL AND needs_review=0 ORDER BY is_primary DESC,id LIMIT 6")?;
            let websites=queue(stmt.query_map([&client],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?);
            view["operations"]=serde_json::json!({"counts":counts,"requests":requests,"staff":staff,"websites":websites});
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
