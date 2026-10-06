//! The activity feed is a permission-filtered projection, never raw audit JSON.
use crate::{
    db::Database,
    error::{Error, Result},
    history_cursor::{self, Boundary},
    query::{Query, row_json},
    security::{self, Actor},
};
use rusqlite::{Transaction, params};
use serde_json::Value;

fn describe(event: &str) -> Option<&'static str> {
    Some(match event {
        "client.created" => "Client created.",
        "client.updated" => "Client updated.",
        "client.archived" => "Client archived.",
        "website.created" => "Website created.",
        "website.updated" => "Website updated.",
        "website.archived" => "Website archived.",
        "task.created" => "Task created.",
        "task.updated" => "Task updated.",
        "task.archived" => "Task archived.",
        "task.completed" => "Task completed.",
        "task.cancelled" => "Task cancelled.",
        "plan.created" => "Plan created.",
        "plan.updated" => "Plan updated.",
        "plan.archived" => "Plan archived.",
        "milestone.created" => "Milestone created.",
        "milestone.updated" => "Milestone updated.",
        "milestone.archived" => "Milestone archived.",
        "reminder.created" => "Reminder created.",
        "reminder.updated" => "Reminder updated.",
        "reminder.completed" => "Reminder completed.",
        "reminder.dismissed" => "Reminder dismissed.",
        _ => return None,
    })
}

pub(crate) fn authorize(tx: &Transaction<'_>, actor: &Actor, client: &str) -> Result<()> {
    security::fresh(tx, actor)?;
    if !security::allowed_user(tx, &actor.user_id, "clients.view", Some(client))?
        || !security::allowed_user(tx, &actor.user_id, "activity.view", Some(client))?
    {
        return Err(Error::NotFound);
    }
    security::client(tx, client, false)
}

pub(crate) fn project(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    boundary: Option<&Boundary>,
    limit: usize,
) -> Result<Vec<Value>> {
    let tasks = security::allowed_user(tx, &actor.user_id, "tasks.view", Some(client))?;
    let plans = security::allowed_user(tx, &actor.user_id, "planning.view", Some(client))?;
    let reminders = security::allowed_user(tx, &actor.user_id, "reminders.view", Some(client))?;
    let mut statement=tx.prepare("SELECT id,client_id,occurred_at,event_name AS event_type,resource_kind,resource_id FROM audit_events WHERE schema_version=1 AND client_id=?1 AND ((resource_kind IN ('client','website') AND event_name IN ('client.created','client.updated','client.archived','website.created','website.updated','website.archived')) OR (?2 AND resource_kind='task' AND event_name IN ('task.created','task.updated','task.archived','task.completed','task.cancelled')) OR (?3 AND resource_kind IN ('plan','milestone') AND event_name IN ('plan.created','plan.updated','plan.archived','milestone.created','milestone.updated','milestone.archived')) OR (?4 AND resource_kind='reminder' AND event_name IN ('reminder.created','reminder.updated','reminder.completed','reminder.dismissed'))) AND (?5 IS NULL OR (occurred_at,id)<(?5,?6)) ORDER BY occurred_at DESC,id DESC LIMIT ?7")?;
    let mut data = statement
        .query_map(
            params![
                client,
                tasks,
                plans,
                reminders,
                boundary.map(|b| b.time.as_str()),
                boundary.map(|b| b.id.as_str()),
                limit as i64
            ],
            row_json,
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for item in &mut data {
        let name = item
            .get("event_type")
            .and_then(Value::as_str)
            .ok_or(Error::Internal)?;
        let kind = item
            .get("resource_kind")
            .and_then(Value::as_str)
            .ok_or(Error::Internal)?;
        if !name.starts_with(&format!("{kind}.")) {
            return Err(Error::Internal);
        }
        let summary = describe(name).ok_or(Error::Internal)?;
        for key in ["id", "client_id", "resource_id"] {
            crate::validation::id(
                item.get(key)
                    .and_then(Value::as_str)
                    .ok_or(Error::Internal)?,
            )
            .map_err(|_| Error::Internal)?;
        }
        history_cursor::utc(
            item.get("occurred_at")
                .and_then(Value::as_str)
                .ok_or(Error::Internal)?,
        )
        .map_err(|_| Error::Internal)?;
        item["summary"] = Value::String(summary.into());
    }
    Ok(data)
}

pub async fn list(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let limit = history_cursor::limit(query.get("limit"))?;
    let boundary = history_cursor::decode(&client, query.get("cursor"))?;
    db.read(move |tx| {
        authorize(tx, &actor, &client)?;
        let mut data = project(tx, &actor, &client, boundary.as_ref(), limit + 1)?;
        let more = data.len() > limit;
        data.truncate(limit);
        let cursor = if more {
            let last = data.last().ok_or(Error::Internal)?;
            Some(history_cursor::encode(
                &client,
                last["occurred_at"].as_str().ok_or(Error::Internal)?,
                last["id"].as_str().ok_or(Error::Internal)?,
            )?)
        } else {
            None
        };
        Ok(serde_json::json!({"data":data,"page":{"limit":limit,"next_cursor":cursor}}))
    })
    .await
}
