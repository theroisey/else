//! Bounded operational generation shares the existing Pingora background lifecycle.
use super::*;
use crate::{db::Database, query::row_json};
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::Value;

pub async fn tick(db: &Database) -> Result<bool> {
    let now = validation::now();
    let horizon = (Utc::now() + Duration::days(1)).date_naive().to_string();
    let tasks=db.read({let now=now.clone();let horizon=horizon.clone();move|tx|{
        let mut stmt=tx.prepare("SELECT r.id,r.client_id,r.managed_by,r.next_date,v.timezone FROM recurring_tasks r JOIN recurring_task_versions v ON v.template_id=r.id AND v.number=r.current_version WHERE r.status='active' AND r.next_date<=?1 AND NOT EXISTS(SELECT 1 FROM automation_failures f WHERE f.kind='task' AND f.resource_id=r.id AND f.retry_after>?2) ORDER BY r.next_date,r.id LIMIT 100")?;
        Ok(stmt.query_map(params![horizon,now],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }}).await?;
    let agreements=db.read({let now=now.clone();move|tx|{
        let mut stmt=tx.prepare("SELECT id,client_id,managed_by,next_date,timezone FROM service_agreements a WHERE status='active' AND next_date<=?1 AND NOT EXISTS(SELECT 1 FROM automation_failures f WHERE f.kind='agreement' AND f.resource_id=a.id AND f.retry_after>?2) ORDER BY next_date,id LIMIT 100")?;
        Ok(stmt.query_map(params![horizon,now],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }}).await?;
    let mut changed = false;
    for (kind, records) in [("task", tasks), ("agreement", agreements)] {
        let mut processed = 0;
        for record in records {
            if processed >= 25 {
                break;
            }
            let date = record["next_date"].as_str().ok_or(Error::Internal)?;
            let timezone = record["timezone"].as_str().ok_or(Error::Internal)?;
            if schedule::date(date)? > schedule::today(timezone)? {
                continue;
            }
            processed += 1;
            let r = record.clone();
            let result = db
                .write(move |tx| {
                    let client = r["client_id"].as_str().ok_or(Error::Internal)?;
                    let id = r["id"].as_str().ok_or(Error::Internal)?;
                    let actor =
                        Actor::job(r["managed_by"].as_str().ok_or(Error::Internal)?.into())?;
                    // The stored manager is re-read after writer admission; a queued
                    // tick cannot retain authority after management transfer.
                    let table = if kind == "task" {
                        "recurring_tasks"
                    } else {
                        "service_agreements"
                    };
                    let manager: String = tx.query_row(
                        &format!("SELECT managed_by FROM {table} WHERE id=?1 AND client_id=?2"),
                        params![id, client],
                        |row| row.get(0),
                    )?;
                    if manager != actor.user_id {
                        return Err(Error::Conflict("generation_changed"));
                    }
                    if kind == "task" {
                        recurring::generate_in_transaction(
                            tx,
                            &actor,
                            client,
                            id,
                            r["next_date"].as_str().ok_or(Error::Internal)?,
                        )?;
                    } else {
                        commercial::generate_in_transaction(
                            tx,
                            &actor,
                            client,
                            id,
                            r["next_date"].as_str().ok_or(Error::Internal)?,
                        )?;
                    }
                    tx.execute(
                        "DELETE FROM automation_failures WHERE kind=?1 AND resource_id=?2",
                        params![kind, id],
                    )?;
                    Ok(())
                })
                .await;
            match result {
                Ok(()) => changed = true,
                Err(error) => {
                    if matches!(error, Error::Busy) {
                        continue;
                    }
                    tracing::warn!(error_code = error.code(), "operation_generation_failed");
                    failure(db, kind, record, error.code()).await?;
                }
            }
        }
    }
    alerts(db).await?;
    Ok(changed)
}
async fn failure(
    db: &Database,
    kind: &'static str,
    record: Value,
    code: &'static str,
) -> Result<()> {
    db.write(move|tx|{
        let id=record["id"].as_str().ok_or(Error::Internal)?;let client=record["client_id"].as_str().ok_or(Error::Internal)?;
        let table=if kind=="task"{"recurring_tasks"}else{"service_agreements"};
        let current:bool=tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1 AND status='active' AND next_date=?2 AND managed_by=?3)"),params![id,record["next_date"].as_str(),record["managed_by"].as_str()],|r|r.get(0))?;
        if !current{return Ok(())}
        let now=validation::now();let retry=(Utc::now()+Duration::minutes(5)).to_rfc3339_opts(SecondsFormat::Micros,true);
        tx.execute("INSERT INTO automation_failures VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(kind,resource_id) DO UPDATE SET error_code=excluded.error_code,failed_at=excluded.failed_at,retry_after=excluded.retry_after",params![kind,id,client,code,now,retry])?;
        notifications::emit_failure(tx,client,id,kind,&format!("failure:{kind}:{id}:{}:{code}",record["next_date"].as_str().ok_or(Error::Internal)?))?;
        Ok(())
    }).await
}
fn mark_alert(
    tx: &Transaction<'_>,
    key: &str,
    task: Option<&str>,
    period: Option<&str>,
) -> Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO automation_alerts VALUES (?1,?2,?3,?4)",
        params![key, task, period, validation::now()],
    )?;
    Ok(())
}
async fn alerts(db: &Database) -> Result<()> {
    db.write(move|tx|{
        let now=validation::now();let horizon=(Utc::now()+Duration::days(1)).to_rfc3339_opts(SecondsFormat::Micros,true);
        let mut stmt=tx.prepare("SELECT t.id,t.due_at,'task-'||(CASE WHEN t.due_at<?2 THEN 'overdue' ELSE 'due' END)||':'||t.id||':'||t.assignee_id||':'||t.due_at AS event_key FROM tasks t WHERE t.archived_at IS NULL AND t.status NOT IN ('done','cancelled') AND t.assignee_id IS NOT NULL AND t.due_at<=?1 AND NOT EXISTS(SELECT 1 FROM automation_alerts n WHERE n.event_key='task-'||(CASE WHEN t.due_at<?2 THEN 'overdue' ELSE 'due' END)||':'||t.id||':'||t.assignee_id||':'||t.due_at) ORDER BY t.due_at,t.id LIMIT 50")?;
        let due=stmt.query_map(params![horizon,now],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for (id,date,key) in due{
            notifications::emit_task(tx,&id,if date<now{"task_overdue"}else{"task_due"},&key,true)?;mark_alert(tx,&key,Some(&id),None)?;
        }
        let mut stmt=tx.prepare("SELECT b.id,c.due_date,'period-'||(CASE WHEN c.due_date<?2 THEN 'overdue' ELSE 'due' END)||':'||b.id||':'||c.due_date||':'||c.revision AS event_key FROM billing_periods b JOIN collections c ON c.id=b.collection_id WHERE b.voided_at IS NULL AND c.cancelled_at IS NULL AND c.paid_minor<c.amount_minor AND c.due_date<=?1 AND NOT EXISTS(SELECT 1 FROM automation_alerts n WHERE n.event_key='period-'||(CASE WHEN c.due_date<?2 THEN 'overdue' ELSE 'due' END)||':'||b.id||':'||c.due_date||':'||c.revision) ORDER BY c.due_date,b.id LIMIT 50")?;
        let due=stmt.query_map(params![&horizon[..10],&now[..10]],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for (id,date,key) in due{
            notifications::emit_period(tx,&id,if date.as_str()<&now[..10]{"payment_overdue"}else{"payment_due"},&key)?;mark_alert(tx,&key,None,Some(&id))?;
        }
        let mut stmt=tx.prepare("SELECT b.id,b.client_id,'settlement:'||b.id||':'||c.revision||':'||(SELECT count(*) FROM internal_settlements s WHERE s.period_id=b.id) AS event_key FROM billing_periods b JOIN agreement_versions v ON v.id=b.version_id JOIN collections c ON c.id=b.collection_id WHERE b.voided_at IS NULL AND v.partner_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM automation_alerts n WHERE n.event_key='settlement:'||b.id||':'||c.revision||':'||(SELECT count(*) FROM internal_settlements s WHERE s.period_id=b.id)) ORDER BY b.id LIMIT 50")?;
        let unsettled=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for (id,client,key) in unsettled{
            let p=commercial::period_document(tx,&client,&id)?;
            if p["internal_remaining_to_roise_minor"]!="0"{notifications::emit_period(tx,&id,"settlement_due",&key)?;}mark_alert(tx,&key,None,Some(&id))?;
        }
        let cutoff=(Utc::now()-Duration::hours(24)).to_rfc3339_opts(SecondsFormat::Micros,true);
        tx.execute("DELETE FROM request_evidence WHERE id IN (SELECT id FROM request_evidence WHERE request_id IS NULL AND created_at<?1 LIMIT 50)",[cutoff])?;
        Ok(())
    }).await
}
