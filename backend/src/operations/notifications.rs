//! Per-user inbox with current destination authorization and deduplicated events.
use super::*;
use crate::{
    db::Database,
    query::{Query, row_json},
};
use serde_json::{Value, json};
pub(crate) fn emit_request(
    tx: &Transaction<'_>,
    actor: &Actor,
    id: &str,
    kind: &str,
    revision: i64,
) -> Result<()> {
    let visible = requests::visibility_sql("u.id");
    let accepts = grant_sql("u.id", "tickets.accept", "r.client_id");
    let approves = grant_sql("u.id", "tickets.approve", "r.client_id");
    let audience = if kind == "created" {
        accepts
    } else if matches!(kind, "delivered" | "accepted" | "rejected") {
        format!("(r.created_by=u.id OR {approves})")
    } else {
        format!("(r.created_by=u.id OR r.assignee_id=u.id OR {approves})")
    };
    let preference = preference_sql("u.id", "workflow");
    tx.execute(&format!("INSERT OR IGNORE INTO notifications(id,user_id,client_id,request_id,event_key,kind,created_at) SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),u.id,r.client_id,r.id,?3,?4,?5 FROM technical_requests r JOIN users u ON u.status='active' WHERE r.id=?1 AND u.id<>?2 AND {visible} AND {audience} AND {preference}"),params![id,actor.user_id,format!("request:{id}:{revision}"),kind,validation::now()])?;
    Ok(())
}
fn visible() -> String {
    let finance = financial_visibility("?1", "n.client_id");
    let template = grant_sql("?1", "recurring.view", "n.client_id");
    let client = grant_sql("?1", "clients.view", "n.client_id");
    format!(
        "((n.request_id IS NOT NULL AND EXISTS(SELECT 1 FROM technical_requests r WHERE r.id=n.request_id AND r.client_id=n.client_id AND {})) OR (n.task_id IS NOT NULL AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=n.task_id AND t.client_id=n.client_id AND {})) OR (n.period_id IS NOT NULL AND {finance} AND EXISTS(SELECT 1 FROM billing_periods b WHERE b.id=n.period_id AND b.client_id=n.client_id)) OR (n.agreement_id IS NOT NULL AND {finance} AND EXISTS(SELECT 1 FROM service_agreements a WHERE a.id=n.agreement_id AND a.client_id=n.client_id)) OR (n.template_id IS NOT NULL AND {template} AND {client} AND EXISTS(SELECT 1 FROM recurring_tasks r WHERE r.id=n.template_id AND r.client_id=n.client_id)))",
        requests::visibility_sql("?1"),
        crate::tasks::visibility_sql("?1")
    )
}
pub async fn list(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let limit = crate::history_cursor::limit(q.get("limit"))?;
    q.choice("sort", "-id", &["-id"])?;
    let unread = q.choice("unread", "false", &["true", "false"])?.to_owned();
    let purpose = hash(&("notifications-v1", &actor.user_id, &unread))?;
    let boundary = crate::history_cursor::decode(&purpose, q.get("cursor"))?;
    db.read(move|tx|{
        security::fresh(tx,&actor)?;let condition=visible();
        let count:i64=tx.query_row(&format!("SELECT count(*) FROM notifications n WHERE n.user_id=?1 AND n.read_at IS NULL AND {condition}"),[&actor.user_id],|r|r.get(0))?;
        let mut stmt=tx.prepare(&format!("SELECT n.id,n.client_id,n.request_id,n.task_id,n.period_id,n.agreement_id,n.template_id,n.kind,n.created_at,n.read_at FROM notifications n WHERE n.user_id=?1 AND {condition} AND (?2 IS NULL OR (n.created_at,n.id)<(?2,?3)) AND (?4='false' OR n.read_at IS NULL) ORDER BY n.created_at DESC,n.id DESC LIMIT ?5"))?;
        let mut items=stmt.query_map(params![actor.user_id,boundary.as_ref().map(|b|&b.time),boundary.as_ref().map(|b|&b.id),unread,(limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=items.len()>limit;items.truncate(limit);
        let next=if more {let last=items.last().ok_or(Error::Internal)?;Some(crate::history_cursor::encode(&purpose,last["created_at"].as_str().ok_or(Error::Internal)?,last["id"].as_str().ok_or(Error::Internal)?)?)}else{None};
        Ok(json!({"data":items,"page":{"limit":limit,"next_cursor":next},"unread_count":count.to_string()}))
    }).await
}

pub async fn mark(db: &Database, actor: Actor, id: Option<String>) -> Result<Value> {
    db.write(move|tx|{
        security::fresh(tx,&actor)?;
        let visible=visible();
        if let Some(id)=&id {
            let exists:bool=tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM notifications n WHERE n.id=?2 AND n.user_id=?1 AND {visible})"),params![actor.user_id,id],|r|r.get(0))?;
            if !exists{return Err(Error::NotFound)}
        }
        tx.execute(&format!("UPDATE notifications AS n SET read_at=coalesce(read_at,?3) WHERE n.user_id=?1 AND (?2 IS NULL OR n.id=?2) AND {visible}"),params![actor.user_id,id,validation::now()])?;
        Ok(json!({"marked":true}))
    }).await
}

fn preference_sql(user: &str, kind: &str) -> String {
    format!(
        "NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.user_id={user} AND p.{kind}=0)"
    )
}
fn financial_visibility(user: &str, client: &str) -> String {
    format!(
        "({} AND {} AND {})",
        grant_sql(user, "clients.view", client),
        grant_sql(user, "agreements.view", client),
        grant_sql(user, "billing.view", client)
    )
}
fn insert(
    tx: &Transaction<'_>,
    user: &str,
    client: &str,
    parent: &str,
    id: &str,
    kind: &str,
    key: &str,
) -> Result<()> {
    // The parent column is selected by compiled callers only.
    tx.execute(&format!("INSERT OR IGNORE INTO notifications(id,user_id,client_id,{parent},kind,event_key,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)"),params![validation::new_id(),user,client,id,kind,key,validation::now()])?;
    Ok(())
}
pub(crate) fn emit_task(
    tx: &Transaction<'_>,
    id: &str,
    kind: &str,
    key: &str,
    supervisors: bool,
) -> Result<()> {
    let visibility = crate::tasks::visibility_sql("u.id");
    let preference = preference_sql("u.id", "tasks");
    let leader = grant_sql("u.id", "tasks.read_team", "t.client_id");
    let owner = grant_sql("u.id", "staff.manage", "t.client_id");
    // Ordinary assignment has at most one recipient. Bind that recipient
    // before evaluating record permissions, including zero recipients for an
    // unassigned task. A user-directory scan here serializes unrelated writes.
    let recipients = if supervisors {
        "JOIN users u ON u.status='active'"
    } else {
        "JOIN users u ON u.id=t.assignee_id AND u.status='active'"
    };
    let mut stmt=tx.prepare(&format!("SELECT u.id,t.client_id FROM tasks t {recipients} WHERE t.id=?1 AND {visibility} AND {preference} AND (t.assignee_id=u.id OR (?2 AND ({leader} OR {owner})))"))?;
    let audience = stmt
        .query_map(params![id, supervisors], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (user, client) in audience {
        insert(tx, &user, &client, "task_id", id, kind, key)?;
    }
    Ok(())
}
pub(crate) fn emit_period(tx: &Transaction<'_>, id: &str, kind: &str, key: &str) -> Result<()> {
    let visible = financial_visibility("u.id", "b.client_id");
    let preference = preference_sql("u.id", "finance");
    let mut stmt=tx.prepare(&format!("SELECT u.id,b.client_id FROM billing_periods b JOIN users u ON u.status='active' WHERE b.id=?1 AND {visible} AND {preference}"))?;
    let audience = stmt
        .query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (user, client) in audience {
        insert(tx, &user, &client, "period_id", id, kind, key)?;
    }
    Ok(())
}
pub(crate) fn emit_failure(
    tx: &Transaction<'_>,
    client: &str,
    id: &str,
    kind: &str,
    key: &str,
) -> Result<()> {
    let (read, manage, parent, category) = if kind == "task" {
        ("recurring.view", "recurring.manage", "template_id", "tasks")
    } else {
        (
            "agreements.view",
            "agreements.manage",
            "agreement_id",
            "finance",
        )
    };
    let scope = grant_sql("u.id", read, "?1");
    let manage = grant_sql("u.id", manage, "?1");
    let client_read = grant_sql("u.id", "clients.view", "?1");
    let preference = preference_sql("u.id", category);
    let finance = if kind == "agreement" {
        grant_sql("u.id", "billing.view", "?1")
    } else {
        "1".into()
    };
    let mut stmt=tx.prepare(&format!("SELECT u.id FROM users u WHERE u.status='active' AND {scope} AND {manage} AND {client_read} AND {preference} AND {finance}"))?;
    let audience = stmt
        .query_map([client], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for user in audience {
        insert(tx, &user, client, parent, id, "automation_failed", key)?;
    }
    Ok(())
}
