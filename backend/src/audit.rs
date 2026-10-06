use crate::{
    error::{Error, Result},
    security::Actor,
    validation,
};
use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planning_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder_scheduled_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder_timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub billing_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_minor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paid_minor: Option<String>,
}

impl Snapshot {
    pub fn revision(revision: i64) -> Self {
        Self {
            exists: Some(true),
            revision: Some(revision),
            ..Self::default()
        }
    }
}

pub fn request_id() -> String {
    data_encoding::BASE32_NOPAD.encode(uuid::Uuid::new_v4().as_bytes())
}

pub fn validate_snapshot(state: &Snapshot, kind: &str) -> Result<()> {
    if state.revision.is_some_and(|v| v < 0)
        || state
            .status
            .as_deref()
            .is_some_and(|v| kind != "user" || !matches!(v, "active" | "disabled"))
        || state.task_status.as_deref().is_some_and(|v| {
            kind != "task"
                || !matches!(
                    v,
                    "backlog"
                        | "todo"
                        | "in_progress"
                        | "blocked"
                        | "review"
                        | "done"
                        | "cancelled"
                )
        })
        || state
            .planning_status
            .as_deref()
            .is_some_and(|v| !match kind {
                "plan" => matches!(v, "draft" | "active" | "completed" | "cancelled"),
                "milestone" => matches!(v, "planned" | "in_progress" | "completed" | "cancelled"),
                _ => false,
            })
        || state.reminder_status.as_deref().is_some_and(|v| {
            kind != "reminder" || !matches!(v, "pending" | "completed" | "dismissed")
        })
        || state.reminder_scheduled_at.is_some() != state.reminder_timezone.is_some()
        || state.billing_status.as_deref().is_some_and(|v| {
            kind != "billing"
                || !matches!(
                    v,
                    "pending" | "partially_paid" | "paid" | "overdue" | "cancelled"
                )
        })
    {
        return Err(Error::Internal);
    }
    if let Some(time) = &state.reminder_scheduled_at
        && (kind != "reminder"
            || crate::history_cursor::utc(time).is_err()
            || state
                .reminder_timezone
                .as_deref()
                .is_none_or(|name| name == "Local" || name.parse::<chrono_tz::Tz>().is_err()))
    {
        return Err(Error::Internal);
    }
    if (state.currency.is_some() || state.amount_minor.is_some() || state.paid_minor.is_some())
        && kind != "billing"
    {
        return Err(Error::Internal);
    }
    if state
        .currency
        .as_deref()
        .is_some_and(|v| crate::billing::exponent(v).is_err())
    {
        return Err(Error::Internal);
    }
    for money in [&state.amount_minor, &state.paid_minor]
        .into_iter()
        .flatten()
    {
        validation::exact_integer(money, false).map_err(|_| Error::Internal)?;
    }
    Ok(())
}

pub struct Event<'a> {
    pub actor: Option<&'a Actor>,
    pub request_id: &'a str,
    pub kind: &'a str,
    pub id: &'a str,
    pub client: Option<&'a str>,
    pub action: &'a str,
    pub before: Option<Snapshot>,
    pub after: Option<Snapshot>,
    pub source: &'a str,
}

/// Import/direct storage has the same typed privacy boundary as application writers.
pub(crate) fn storage_payload(kind: &str, before: &str, after: &str, metadata: &str) -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Metadata {
        source: String,
    }
    let valid = || -> Result<()> {
        for raw in [before, after] {
            let snapshot: Option<Snapshot> = validation::json(raw.as_bytes())?;
            if let Some(snapshot) = snapshot {
                validate_snapshot(&snapshot, kind)?;
            }
        }
        let metadata: Metadata = validation::json(metadata.as_bytes())?;
        if !matches!(metadata.source.as_str(), "http" | "job" | "cli") {
            return Err(Error::Internal);
        }
        Ok(())
    };
    valid().is_ok()
}

pub fn append(tx: &Transaction<'_>, event: Event<'_>) -> Result<()> {
    let action_valid = match event.action {
        "created" | "updated" | "archived" | "deleted" => true,
        "disabled" => event.kind == "user",
        "permission_changed" => event.kind == "role",
        "completed" | "cancelled" => {
            event.kind == "task"
                || (event.action == "completed" && event.kind == "reminder")
                || (event.action == "cancelled" && event.kind == "billing")
        }
        "payment_recorded" => event.kind == "billing",
        "dismissed" => event.kind == "reminder",
        _ => false,
    };
    if !action_valid
        || !matches!(event.source, "http" | "job" | "cli")
        || event.kind.is_empty()
        || event.kind.len() > 32
        || !event
            .kind
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        || event.request_id.len() != 26
        || !event
            .request_id
            .bytes()
            .all(|c| c.is_ascii_uppercase() || (b'2'..=b'7').contains(&c))
    {
        return Err(Error::Internal);
    }
    validation::id(event.id).map_err(|_| Error::Internal)?;
    for state in [&event.before, &event.after].into_iter().flatten() {
        validate_snapshot(state, event.kind)?;
        if (state.status.is_some() && event.kind != "user")
            || (state.task_status.is_some() && event.kind != "task")
            || (state.planning_status.is_some() && !matches!(event.kind, "plan" | "milestone"))
            || (state.reminder_status.is_some() && event.kind != "reminder")
            || (state.billing_status.is_some() && event.kind != "billing")
        {
            return Err(Error::Internal);
        }
    }
    let before = serde_json::to_string(&event.before).map_err(|_| Error::Internal)?;
    let after = serde_json::to_string(&event.after).map_err(|_| Error::Internal)?;
    let metadata = serde_json::to_string(&serde_json::json!({"source":event.source}))
        .map_err(|_| Error::Internal)?;
    tx.execute("INSERT INTO audit_events(id,occurred_at,schema_version,actor_kind,actor_user_id,event_name,resource_kind,resource_id,client_id,request_id,before_state,after_state,metadata) VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![validation::new_id(),validation::now(),if event.actor.is_some(){"user"}else{"system"},event.actor.map(|a|a.user_id.as_str()),format!("{}.{}",event.kind,event.action),event.kind,event.id,event.client,event.request_id,before,after,metadata])?;
    Ok(())
}

pub fn mutation(
    tx: &Transaction<'_>,
    actor: &Actor,
    kind: &str,
    id: &str,
    client: Option<&str>,
    action: &str,
    states: (Option<Snapshot>, Snapshot),
) -> Result<()> {
    append(
        tx,
        Event {
            actor: Some(actor),
            request_id: &actor.request_id,
            kind,
            id,
            client,
            action,
            before: states.0,
            after: Some(states.1),
            source: actor.source(),
        },
    )
}
