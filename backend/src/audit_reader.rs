//! Read contracts deliberately omit the financial and credential storage fields.
use crate::{
    audit::Snapshot,
    db::Database,
    error::{Error, Result},
    history_cursor,
    query::{Query, row_json},
    security::{self, Actor},
    validation,
};
use rusqlite::{Transaction, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const FILTERS: &[&str] = &[
    "limit",
    "cursor",
    "actor_id",
    "actor_kind",
    "event_type",
    "client_id",
    "resource_kind",
    "resource_id",
    "request_id",
    "from",
    "to",
];
const SUMMARY: &str = "id,schema_version,occurred_at,actor_kind,actor_user_id,event_name AS event_type,resource_kind,resource_id,client_id,request_id";
// Audit authority alone grants global events. A linked event independently
// requires a real visible client, evaluated inside the same read transaction.
const VISIBLE: &str = "(e.client_id IS NULL OR EXISTS(SELECT 1 FROM clients c JOIN user_roles ur ON ur.user_id=?1 JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE c.id=e.client_id AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND rp.permission_key='clients.view' AND (ur.scope_kind='global' OR ur.client_id=c.id)))";

#[derive(Serialize)]
#[allow(non_snake_case)]
struct Filter {
    Limit: usize,
    Cursor: String,
    ActorID: String,
    ActorKind: String,
    EventType: String,
    ClientID: String,
    ResourceKind: String,
    ResourceID: String,
    RequestID: String,
    From: Option<String>,
    To: Option<String>,
}

fn kind(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
fn event(value: &str) -> bool {
    let Some((resource, action)) = value.split_once('.') else {
        return false;
    };
    kind(resource)
        && match action {
            "created" | "updated" | "archived" | "deleted" => true,
            "disabled" => resource == "user",
            "permission_changed" => resource == "role",
            "completed" => matches!(resource, "task" | "reminder"),
            "cancelled" => matches!(resource, "task" | "billing"),
            "payment_recorded" => resource == "billing",
            "dismissed" => resource == "reminder",
            _ => false,
        }
}
fn correlation(raw: &str) -> bool {
    raw.len() == 26
        && raw
            .bytes()
            .all(|c| c.is_ascii_uppercase() || (b'2'..=b'7').contains(&c))
}

impl Filter {
    fn parse(scope: Option<&str>, query: &Query) -> Result<Self> {
        if scope.is_some() && query.get("client_id").is_some() {
            return Err(Error::Invalid("invalid_request"));
        }
        let id = |key| -> Result<String> {
            query
                .get(key)
                .map(validation::id)
                .transpose()
                .map(|v| v.unwrap_or_default())
        };
        let f = Self {
            Limit: 0,
            Cursor: String::new(),
            ActorID: id("actor_id")?,
            ActorKind: query.get("actor_kind").unwrap_or("").into(),
            EventType: query.get("event_type").unwrap_or("").into(),
            ClientID: scope.map(str::to_owned).unwrap_or(id("client_id")?),
            ResourceKind: query.get("resource_kind").unwrap_or("").into(),
            ResourceID: id("resource_id")?,
            RequestID: query.get("request_id").unwrap_or("").into(),
            From: query
                .get("from")
                .map(history_cursor::canonical)
                .transpose()?,
            To: query.get("to").map(history_cursor::canonical).transpose()?,
        };
        if (!f.ActorKind.is_empty() && !matches!(f.ActorKind.as_str(), "user" | "system"))
            || (!f.EventType.is_empty() && !event(&f.EventType))
            || (!f.ResourceKind.is_empty() && !kind(&f.ResourceKind))
            || (!f.RequestID.is_empty() && !correlation(&f.RequestID))
            || (f.From.is_some()
                && f.To.is_some()
                && history_cursor::utc(f.From.as_ref().unwrap())?
                    >= history_cursor::utc(f.To.as_ref().unwrap())?)
        {
            return Err(Error::Invalid("invalid_request"));
        }
        Ok(f)
    }
    fn fingerprint(&self, scope: Option<&str>) -> Result<String> {
        // Preserve the original v1 filter serialization so existing cursors
        // continue to bind to precisely the same filters after migration.
        #[derive(Serialize)]
        #[allow(non_snake_case)]
        struct Binding<'a> {
            Scope: &'a str,
            Filter: &'a Filter,
        }
        let bytes = serde_json::to_vec(&Binding {
            Scope: scope.unwrap_or(""),
            Filter: self,
        })
        .map_err(|_| Error::Internal)?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

fn authorize(tx: &Transaction<'_>, actor: &Actor, client: Option<&str>) -> Result<()> {
    security::require(tx, actor, "audit.view", None)?;
    if let Some(client) = client {
        if !security::allowed_user(tx, &actor.user_id, "clients.view", Some(client))? {
            return Err(Error::NotFound);
        }
        security::client(tx, client, false)?;
    }
    Ok(())
}

pub async fn list(
    db: &Database,
    actor: Actor,
    scope: Option<String>,
    query: Query,
) -> Result<Value> {
    let limit = history_cursor::limit(query.get("limit"))?;
    let filter = Filter::parse(scope.as_deref(), &query)?;
    let purpose = filter.fingerprint(scope.as_deref())?;
    let boundary = history_cursor::decode(&purpose, query.get("cursor"))?;
    db.read(move|tx| {
        authorize(tx,&actor,if filter.ClientID.is_empty(){None}else{Some(&filter.ClientID)})?;
        let sql=format!("SELECT {SUMMARY} FROM audit_events e WHERE {VISIBLE} AND (?2='' OR e.client_id=?2) AND (?3='' OR e.actor_user_id=?3) AND (?4='' OR e.actor_kind=?4) AND (?5='' OR e.event_name=?5) AND (?6='' OR e.resource_kind=?6) AND (?7='' OR e.resource_id=?7) AND (?8='' OR e.request_id=?8) AND (?9 IS NULL OR e.occurred_at>=?9) AND (?10 IS NULL OR e.occurred_at<?10) AND (?11 IS NULL OR (e.occurred_at,e.id)<(?11,?12)) ORDER BY e.occurred_at DESC,e.id DESC LIMIT ?13");
        let from=filter.From.as_deref().map(history_cursor::utc).transpose()?;
        let to=filter.To.as_deref().map(history_cursor::utc).transpose()?;
        let mut stmt=tx.prepare(&sql)?;
        let mut data=stmt.query_map(params![actor.user_id,filter.ClientID,filter.ActorID,filter.ActorKind,filter.EventType,filter.ResourceKind,filter.ResourceID,filter.RequestID,from,to,boundary.as_ref().map(|b|b.time.as_str()),boundary.as_ref().map(|b|b.id.as_str()),(limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=data.len()>limit; data.truncate(limit);
        for item in &data { validate_summary(item)?; }
        let cursor=if more {let last=data.last().ok_or(Error::Internal)?;Some(history_cursor::encode(&purpose,string(last,"occurred_at")?,string(last,"id")?)?)}else{None};
        Ok(serde_json::json!({"data":data,"page":{"limit":limit,"next_cursor":cursor}}))
    }).await
}

pub async fn read(db: &Database, actor: Actor, scope: Option<String>, id: String) -> Result<Value> {
    db.read(move|tx| {
        authorize(tx,&actor,scope.as_deref())?;
        let sql=format!("SELECT {SUMMARY},before_state AS before_state_json,after_state AS after_state_json,metadata AS metadata_json FROM audit_events e WHERE e.id=?2 AND (?3 IS NULL OR e.client_id=?3) AND {VISIBLE}");
        let mut item=tx.query_row(&sql,params![actor.user_id,id,scope],row_json)?;
        validate_summary(&item)?;
        let kind=string(&item,"resource_kind")?.to_owned();
        for key in ["before_state","after_state"] {
            item[key]=project_snapshot(item[key].clone(),&kind)?;
        }
        let metadata=item.get("metadata").and_then(Value::as_object).ok_or(Error::Internal)?;
        if metadata.len()!=1 || !matches!(metadata.get("source").and_then(Value::as_str),Some("http"|"job"|"cli")) {return Err(Error::Internal);}
        Ok(item)
    }).await
}

fn string<'a>(item: &'a Value, key: &str) -> Result<&'a str> {
    item.get(key).and_then(Value::as_str).ok_or(Error::Internal)
}
fn validate_summary(item: &Value) -> Result<()> {
    for key in ["id", "resource_id"] {
        validation::id(string(item, key)?).map_err(|_| Error::Internal)?;
    }
    history_cursor::utc(string(item, "occurred_at")?).map_err(|_| Error::Internal)?;
    let valid_actor = match (string(item, "actor_kind")?, item.get("actor_user_id")) {
        ("system", Some(Value::Null)) => true,
        ("user", Some(Value::String(id))) => validation::id(id).is_ok(),
        _ => false,
    };
    let client_valid = match item.get("client_id") {
        Some(Value::Null) => true,
        Some(Value::String(id)) => validation::id(id).is_ok(),
        _ => false,
    };
    let name = string(item, "event_type")?;
    if item.get("schema_version").and_then(Value::as_i64) != Some(1)
        || !valid_actor
        || !client_valid
        || !event(name)
        || !name.starts_with(&format!("{}.", string(item, "resource_kind")?))
        || !correlation(string(item, "request_id")?)
    {
        return Err(Error::Internal);
    }
    Ok(())
}

fn project_snapshot(value: Value, kind: &str) -> Result<Value> {
    if value.is_null() {
        return Ok(value);
    }
    let stored: Snapshot = serde_json::from_value(value).map_err(|_| Error::Internal)?;
    crate::audit::validate_snapshot(&stored, kind)?;
    let mut projected = serde_json::to_value(stored).map_err(|_| Error::Internal)?;
    let map = projected.as_object_mut().ok_or(Error::Internal)?;
    map.retain(|key, _| {
        matches!(
            key.as_str(),
            "exists"
                | "revision"
                | "status"
                | "task_status"
                | "planning_status"
                | "reminder_status"
                | "reminder_scheduled_at"
                | "reminder_timezone"
        )
    });
    if let Some(revision) = map.get_mut("revision") {
        *revision = Value::String(revision.as_i64().ok_or(Error::Internal)?.to_string());
    }
    Ok(projected)
}
