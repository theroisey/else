//! One scoped snapshot replaces per-brand dashboard fan-out.
use super::*;
use crate::{
    db::Database,
    query::{Query, row_json},
};
use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use serde_json::{Value, json};
use std::collections::BTreeMap;
pub(crate) fn task_visibility(user: &str) -> String {
    crate::tasks::visibility_sql(user)
}
pub async fn read(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let client = q.get("client_id").map(validation::id).transpose()?;
    let employee = q.get("employee_id").map(validation::id).transpose()?;
    db.read(move|tx|{
        security::fresh(tx,&actor)?;
        if let Some(employee)=&employee {
            let scope:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM teams tm JOIN team_memberships m ON m.team_id=tm.id WHERE tm.leader_id=?1 AND tm.archived_at IS NULL AND m.revoked_at IS NULL AND m.user_id=?2)",params![actor.user_id,employee],|r|r.get(0))?;
            if !scope && !security::allowed_user(tx,&actor.user_id,"staff.manage",None)?{return Err(Error::NotFound)}
        }
        let now=validation::now();let horizon=DateTime::parse_from_rfc3339(&now).map_err(|_|Error::Internal)?.with_timezone(&Utc).checked_add_signed(TimeDelta::days(7)).ok_or(Error::Internal)?.to_rfc3339_opts(SecondsFormat::Micros,true);
        let zone:String=tx.query_row("SELECT timezone FROM operation_settings WHERE id=1",[],|r|r.get(0))?;
        let mut output=json!({"as_of":now,"horizon_end":horizon,"timezone":zone});
        let mut counts:BTreeMap<String,String>=requests::STATES.iter().map(|s|(s.to_string(),"0".into())).collect();
        let mut stmt=tx.prepare(&format!("SELECT r.status,count(*) FROM technical_requests r WHERE {} AND (?2 IS NULL OR r.client_id=?2) AND (?3 IS NULL OR r.created_by=?3) GROUP BY r.status",requests::visibility_sql("?1")))?;
        let mut rows=stmt.query(params![actor.user_id,client,employee])?;
        while let Some(row)=rows.next()? { counts.insert(row.get::<_,String>(0)?,row.get::<_,i64>(1)?.to_string()); }
        output["request_counts"]=json!(counts);
        let mut stmt=tx.prepare(&format!("SELECT r.id,r.client_id,r.title,r.status,r.priority,r.due_at,c.name AS brand_name,u.display_name AS requester_name FROM technical_requests r JOIN clients c ON c.id=r.client_id JOIN users u ON u.id=r.created_by WHERE {} AND r.status NOT IN ('approved','rejected','cancelled') AND (?2 IS NULL OR r.client_id=?2) AND (?3 IS NULL OR r.created_by=?3) ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'revision_requested' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END,r.created_at,r.id LIMIT 11",requests::visibility_sql("?1")))?;
        let mut requests=stmt.query_map(params![actor.user_id,client,employee],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;let more=requests.len()>10;requests.truncate(10);output["requests"]=json!({"items":requests,"has_more":more});
        let task_visible=task_visibility("?1");
        let count:i64=tx.query_row(&format!("SELECT count(*) FROM tasks t WHERE {task_visible} AND t.archived_at IS NULL AND t.status NOT IN ('done','cancelled') AND t.due_at<?2 AND (?3 IS NULL OR t.client_id=?3) AND (?4 IS NULL OR t.assignee_id=?4)"),params![actor.user_id,now,client,employee],|r|r.get(0))?;output["overdue_tasks"]=json!(count.to_string());
        let mut stmt=tx.prepare(&format!("SELECT t.id,t.client_id,t.title,t.status,t.due_at,c.name AS brand_name,u.display_name AS assignee_name FROM tasks t JOIN clients c ON c.id=t.client_id LEFT JOIN users u ON u.id=t.assignee_id WHERE {task_visible} AND t.archived_at IS NULL AND t.status NOT IN ('done','cancelled') AND (t.due_at IS NULL OR t.due_at<=?2) AND (?3 IS NULL OR t.client_id=?3) AND (?4 IS NULL OR t.assignee_id=?4) ORDER BY t.due_at IS NULL,t.due_at,t.id LIMIT 11"))?;
        let mut tasks=stmt.query_map(params![actor.user_id,horizon,client,employee],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;let more=tasks.len()>10;tasks.truncate(10);output["tasks"]=json!({"items":tasks,"has_more":more});
        let reminder_read=grant_sql("?1","reminders.view","m.client_id");
        let reminder_all=grant_sql("?1","tickets.read_all","m.client_id");
        let mut stmt=tx.prepare(&format!("SELECT m.id,m.client_id,m.title,m.scheduled_at,m.timezone,c.name AS brand_name FROM reminders m JOIN clients c ON c.id=m.client_id WHERE {reminder_read} AND (m.owner_id=?1 OR {reminder_all}) AND m.status='pending' AND m.scheduled_at<=?2 AND (?3 IS NULL OR m.client_id=?3) AND (?4 IS NULL OR m.owner_id=?4) ORDER BY m.scheduled_at,m.id LIMIT 11"))?;
        let mut reminders=stmt.query_map(params![actor.user_id,horizon,client,employee],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;let more=reminders.len()>10;reminders.truncate(10);output["reminders"]=json!({"items":reminders,"has_more":more});
        let brand=grant_sql("?1","clients.view","c.id");
        let mut stmt=tx.prepare(&format!("SELECT c.id,c.name,CAST((SELECT count(*) FROM client_websites w WHERE w.client_id=c.id AND w.archived_at IS NULL) AS TEXT) AS websites FROM clients c WHERE c.archived_at IS NULL AND {brand} AND (?2 IS NULL OR c.id=?2) ORDER BY c.name,c.id LIMIT 13"))?;
        let mut brands=stmt.query_map(params![actor.user_id,client],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;let more=brands.len()>12;brands.truncate(12);output["brands"]=json!({"items":brands,"has_more":more});
        if security::allowed_user(tx,&actor.user_id,"staff.read_team",None)? || security::allowed_user(tx,&actor.user_id,"staff.manage",None)? {
            let all=security::allowed_user(tx,&actor.user_id,"staff.manage",None)?;
            let count:i64=tx.query_row("SELECT count(DISTINCT m.user_id) FROM teams tm JOIN team_memberships m ON m.team_id=tm.id JOIN users u ON u.id=m.user_id WHERE tm.archived_at IS NULL AND m.revoked_at IS NULL AND u.status='active' AND (?1 OR tm.leader_id=?2)",params![all,actor.user_id],|r|r.get(0))?;output["team_members"]=json!(count.to_string());
        }
        if security::allowed_user(tx,&actor.user_id,"finance.read_company",None)? {
            let billing=grant_sql("?1","billing.view","c.client_id");let mut stmt=tx.prepare(&format!("SELECT c.currency,c.amount_minor-c.paid_minor,c.due_date FROM collections c WHERE c.cancelled_at IS NULL AND c.paid_minor<c.amount_minor AND {billing} AND (?2 IS NULL OR c.client_id=?2)"))?;
            let mut rows=stmt.query(params![actor.user_id,client])?;let mut totals=BTreeMap::<String,(i128,i128)>::new();
            while let Some(row)=rows.next()? {let currency:String=row.get(0)?;let amount:i64=row.get(1)?;let due:Option<String>=row.get(2)?;let v=totals.entry(currency).or_default();v.0=v.0.checked_add(i128::from(amount)).ok_or(Error::Internal)?;if due.as_deref().is_some_and(|d|d<&now[..10]){v.1=v.1.checked_add(i128::from(amount)).ok_or(Error::Internal)?}}
            output["finance"]=json!(totals.into_iter().map(|(currency,(outstanding,overdue))|json!({"currency":currency,"outstanding_minor":outstanding.to_string(),"overdue_minor":overdue.to_string()})).collect::<Vec<_>>());
            let agreements=grant_sql("?1","agreements.view","b.client_id");let access=grant_sql("?1","billing.view","b.client_id");let brand_access=grant_sql("?1","clients.view","b.client_id");
            let mut stmt=tx.prepare(&format!("{} WHERE b.voided_at IS NULL AND v.partner_id IS NOT NULL AND {agreements} AND {access} AND {brand_access} AND (?2 IS NULL OR b.client_id=?2)",commercial::PERIOD_SQL))?;
            let mut rows=stmt.query(params![actor.user_id,client])?;let mut internal=BTreeMap::<String,(i128,i128)>::new();
            while let Some(row)=rows.next()? {let period=commercial::period_position(row_json(row)?)?;let amount:i128=period["internal_remaining_to_roise_minor"].as_str().ok_or(Error::Internal)?.parse().map_err(|_|Error::Internal)?;let currency=period["currency"].as_str().ok_or(Error::Internal)?.to_owned();let entry=internal.entry(currency).or_default();if amount>0{entry.0=entry.0.checked_add(amount).ok_or(Error::Internal)?;}else{entry.1=entry.1.checked_sub(amount).ok_or(Error::Internal)?;}}
            output["internal_finance"]=json!(internal.into_iter().map(|(currency,(receivable,payable))|json!({"currency":currency,"receivable_minor":receivable.to_string(),"payable_minor":payable.to_string()})).collect::<Vec<_>>());

        }
        Ok(output)
    }).await
}
