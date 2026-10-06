use crate::{
    audit::{self, Snapshot},
    clients::ConfirmRevision,
    db::Database,
    error::{Error, Result},
    query::{Mutation, Query, next_revision, row_json},
    security::{self, Actor},
    validation,
};
use chrono::{Datelike, Duration, NaiveDateTime, Offset, SecondsFormat, TimeZone, Utc};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::Value;

const COLUMNS: &str = "r.id,r.client_id,r.created_by,r.owner_id,r.title,r.status,r.scheduled_at,r.scheduled_local,r.timezone,r.utc_offset_seconds,r.completed_at,r.dismissed_at,r.revision,r.created_at,r.updated_at,(r.status='pending' AND r.scheduled_at<=?3) AS is_due,CASE WHEN r.task_id IS NOT NULL THEN json_object('kind','task','id',r.task_id) WHEN r.plan_id IS NOT NULL THEN json_object('kind','plan','id',r.plan_id) WHEN r.milestone_id IS NOT NULL THEN json_object('kind','milestone','id',r.milestone_id) ELSE 'null' END AS resource_json";

#[derive(Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    kind: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    title: String,
    #[serde(default)]
    description: String,
    owner_id: Option<String>,
    scheduled_local: String,
    timezone: String,
    utc_offset_seconds: i32,
    resource: Option<Resource>,
    expected_revision: Option<i64>,
}

struct Normalized {
    profile: Profile,
    scheduled_at: String,
}

impl Profile {
    fn normalize(mut self, updating: bool, actor: &Actor) -> Result<Normalized> {
        if self.expected_revision.is_some() != updating || (updating && self.owner_id.is_none()) {
            return Err(Error::Invalid("invalid_request"));
        }
        self.title = validation::text(&self.title, 200, true, false)?;
        self.description = validation::text(&self.description, 8000, false, true)?;
        self.owner_id = Some(validation::id(
            self.owner_id.as_deref().unwrap_or(&actor.user_id),
        )?);
        if let Some(resource) = &self.resource {
            validation::id(&resource.id)?;
            if !["task", "plan", "milestone"].contains(&resource.kind.as_str()) {
                return Err(Error::Invalid("invalid_resource"));
            }
        }
        let (scheduled_at, local) = schedule(
            &self.scheduled_local,
            &self.timezone,
            self.utc_offset_seconds,
        )?;
        self.scheduled_local = local;
        Ok(Normalized {
            profile: self,
            scheduled_at,
        })
    }
}

pub fn schedule(local: &str, zone: &str, offset: i32) -> Result<(String, String)> {
    let invalid = || Error::Invalid("invalid_schedule");
    if local.len() < 19
        || local.len() > 26
        || !(-86399..=86399).contains(&offset)
        || zone.len() > 100
    {
        return Err(invalid());
    }
    let pattern = local.as_bytes();
    for (i, c) in pattern.iter().enumerate() {
        let expected = match i {
            4 | 7 => Some(b'-'),
            10 => Some(b'T'),
            13 | 16 => Some(b':'),
            19 => Some(b'.'),
            _ => None,
        };
        if expected.is_some_and(|e| *c != e) || (expected.is_none() && !c.is_ascii_digit()) {
            return Err(invalid());
        }
    }
    if local.len() == 20 {
        return Err(invalid());
    }
    if zone != "UTC"
        && (!zone.contains('/')
            || !zone.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            || zone.split('/').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_+-".contains(&c))
            }))
    {
        return Err(invalid());
    }
    if &local[17..19] >= "60" {
        return Err(invalid());
    }
    let tz: chrono_tz::Tz = zone.parse().map_err(|_| invalid())?;
    let wall =
        NaiveDateTime::parse_from_str(local, "%Y-%m-%dT%H:%M:%S%.f").map_err(|_| invalid())?;
    let instant = wall
        .checked_sub_signed(Duration::seconds(i64::from(offset)))
        .ok_or_else(invalid)?;
    if !(1..=9999).contains(&wall.year()) || !(1..=9999).contains(&instant.year()) {
        return Err(invalid());
    }
    let zoned = tz.from_utc_datetime(&instant);
    if zoned.naive_local() != wall || zoned.offset().fix().local_minus_utc() != offset {
        return Err(invalid());
    }
    let canonical = wall
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string()
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned();
    Ok((
        Utc.from_utc_datetime(&instant)
            .to_rfc3339_opts(SecondsFormat::Micros, true),
        canonical,
    ))
}

pub async fn list(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    let status = query
        .choice(
            "status",
            "pending",
            &["pending", "completed", "dismissed", "all"],
        )?
        .to_owned();
    let due = query
        .choice("due", "all", &["all", "due", "upcoming"])?
        .to_owned();
    let search = query.text("q", 100)?;
    let owner = query.get("owner").unwrap_or("any").to_owned();
    if !["any", "me"].contains(&owner.as_str()) {
        validation::id(&owner)?;
    }
    db.read(move |tx| {
        authorize(tx,&actor,&client,None)?;
        let owner=if owner=="me"{actor.user_id.clone()}else{owner};
        let sql=format!("SELECT {COLUMNS} FROM reminders r WHERE r.client_id=?1 AND (?2 IS NULL OR r.id {} ?2) AND (?4='all' OR r.status=?4) AND (?5='all' OR (r.status='pending' AND ((?5='due' AND r.scheduled_at<=?3) OR (?5='upcoming' AND r.scheduled_at>?3)))) AND (?6='any' OR r.owner_id=?6) AND (?7='' OR instr(unicode_lower(r.title),unicode_lower(?7))>0) ORDER BY r.id {} LIMIT ?8",paging.comparison(),paging.order());
        let mut statement=tx.prepare(&sql)?;
        let data=statement.query_map(params![client,paging.cursor,validation::now(),status,due,owner,search,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

pub async fn read(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, None)?;
        document(tx, &client, &id)
    })
    .await
}

pub async fn owners(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move |tx| {
        authorize(tx,&actor,&client,None)?;security::client(tx,&client,true)?;
        security::require_any(tx,&actor,&["reminders.create","reminders.update"],&client).map_err(hidden)?;
        let mut statement=tx.prepare("SELECT u.id,u.display_name FROM users u WHERE u.status='active' AND (?1 IS NULL OR u.id>?1) AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=u.id AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND rp.permission_key='reminders.view' AND (ur.scope_kind='global' OR ur.client_id=?2)) ORDER BY u.id LIMIT ?3")?;
        let data=statement.query_map(params![paging.cursor,client,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    profile: Profile,
) -> Result<Mutation> {
    let normalized = profile.normalize(false, &actor)?;
    let profile = normalized.profile;
    db.write(move |tx| {
        authorize(tx,&actor,&client,Some("reminders.create"))?;
        owner(tx,&client,profile.owner_id.as_deref(),None)?;
        let reference=resource(tx,&actor,&client,profile.resource.as_ref(),None,None)?;
        let id=validation::new_id();let now=validation::now();
        tx.execute("INSERT INTO reminders(id,client_id,created_by,owner_id,title,description,status,scheduled_at,scheduled_local,timezone,utc_offset_seconds,task_id,plan_id,milestone_id,milestone_plan_id,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7,?8,?9,?10,?11,?12,?13,?14,1,?15,?15)",params![id,client,actor.user_id,profile.owner_id,profile.title,profile.description,normalized.scheduled_at,profile.scheduled_local,profile.timezone,profile.utc_offset_seconds,reference.task,reference.plan,reference.milestone,reference.milestone_plan,now])?;
        audit::mutation(tx,&actor,"reminder",&id,Some(&client),"created",(None, snapshot(1,"pending",&normalized.scheduled_at,&profile.timezone)))?;
        Ok(Mutation {id,revision:1})
    }).await
}

pub async fn update(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    profile: Profile,
) -> Result<Mutation> {
    let normalized = profile.normalize(true, &actor)?;
    let profile = normalized.profile;
    db.write(move |tx| {
        authorize(tx,&actor,&client,Some("reminders.update"))?;
        let old=document(tx,&client,&id)?;
        if old["status"]!="pending" {return Err(Error::Conflict("conflict"));}
        let previous=old["revision"].as_i64().ok_or(Error::Internal)?;
        let revision=next_revision(previous,profile.expected_revision.ok_or(Error::Invalid("invalid_request"))?)?;
        owner(tx,&client,profile.owner_id.as_deref(),old["owner_id"].as_str())?;
        let old_resource=if old["resource"].is_null(){None}else{Some(serde_json::from_value::<Resource>(old["resource"].clone()).map_err(|_|Error::Internal)?)};
        let old_parent:Option<String>=tx.query_row("SELECT milestone_plan_id FROM reminders WHERE id=?1",[&id],|r|r.get(0))?;
        let reference=resource(tx,&actor,&client,profile.resource.as_ref(),old_resource.as_ref(),old_parent)?;
        tx.execute("UPDATE reminders SET owner_id=?1,title=?2,description=?3,scheduled_at=?4,scheduled_local=?5,timezone=?6,utc_offset_seconds=?7,task_id=?8,plan_id=?9,milestone_id=?10,milestone_plan_id=?11,revision=?12,updated_at=?13 WHERE id=?14",params![profile.owner_id,profile.title,profile.description,normalized.scheduled_at,profile.scheduled_local,profile.timezone,profile.utc_offset_seconds,reference.task,reference.plan,reference.milestone,reference.milestone_plan,revision,validation::now(),id])?;
        audit::mutation(tx,&actor,"reminder",&id,Some(&client),"updated",(Some(old_snapshot(&old)?), snapshot(revision,"pending",&normalized.scheduled_at,&profile.timezone)))?;
        Ok(Mutation{id,revision})
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Completion {
    pub expected_revision: i64,
}

pub async fn complete(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    input: Completion,
) -> Result<Mutation> {
    finish(db, actor, client, id, input.expected_revision, false).await
}

pub async fn dismiss(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    input: ConfirmRevision,
) -> Result<Mutation> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    finish(db, actor, client, id, input.expected_revision, true).await
}

async fn finish(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    expected: i64,
    dismiss: bool,
) -> Result<Mutation> {
    db.write(move |tx| {
        authorize(tx,&actor,&client,Some("reminders.update"))?;
        let old=document(tx,&client,&id)?;
        if old["status"]!="pending" {return Err(Error::Conflict("conflict"));}
        let revision=next_revision(old["revision"].as_i64().ok_or(Error::Internal)?,expected)?;let now=validation::now();
        let status=if dismiss{"dismissed"}else{"completed"};
        tx.execute("UPDATE reminders SET status=?1,completed_at=?2,dismissed_at=?3,revision=?4,updated_at=?5 WHERE id=?6",params![status,if dismiss{None}else{Some(&now)},if dismiss{Some(&now)}else{None},revision,now,id])?;
        let mut after=old_snapshot(&old)?;after.revision=Some(revision);after.reminder_status=Some(status.into());
        audit::mutation(tx,&actor,"reminder",&id,Some(&client),status,(Some(old_snapshot(&old)?), after))?;
        Ok(Mutation{id,revision})
    }).await
}

fn authorize(tx: &Transaction<'_>, actor: &Actor, client: &str, write: Option<&str>) -> Result<()> {
    security::require(tx, actor, "reminders.view", Some(client)).map_err(hidden)?;
    if let Some(key) = write {
        security::require(tx, actor, key, Some(client)).map_err(hidden)?;
    }
    security::client(tx, client, write.is_some())
}
fn hidden(error: Error) -> Error {
    match error {
        Error::Denied => Error::NotFound,
        _ => error,
    }
}

fn document(tx: &Transaction<'_>, client: &str, id: &str) -> Result<Value> {
    Ok(tx.query_row(
        &format!(
            "SELECT {COLUMNS},r.description FROM reminders r WHERE r.client_id=?1 AND r.id=?2"
        ),
        params![client, id, validation::now()],
        row_json,
    )?)
}

fn owner(tx: &Transaction<'_>, client: &str, new: Option<&str>, old: Option<&str>) -> Result<()> {
    let new = new.ok_or(Error::Invalid("invalid_owner"))?;
    if Some(new) != old && !security::allowed_user(tx, new, "reminders.view", Some(client))? {
        return Err(Error::Invalid("invalid_owner"));
    }
    Ok(())
}

#[derive(Default)]
struct Reference {
    task: Option<String>,
    plan: Option<String>,
    milestone: Option<String>,
    milestone_plan: Option<String>,
}

fn resource(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    new: Option<&Resource>,
    old: Option<&Resource>,
    old_parent: Option<String>,
) -> Result<Reference> {
    let mut output = Reference::default();
    let Some(resource) = new else {
        return Ok(output);
    };
    let retained = new == old;
    let permission = if resource.kind == "task" {
        "tasks.view"
    } else {
        "planning.view"
    };
    if !retained && !security::allowed_user(tx, &actor.user_id, permission, Some(client))? {
        return Err(Error::Invalid("invalid_resource"));
    }
    if resource.kind == "milestone" {
        output.milestone = Some(resource.id.clone());
        output.milestone_plan = if retained {
            old_parent
        } else {
            tx.query_row("SELECT m.plan_id FROM milestones m JOIN plans p ON p.id=m.plan_id WHERE m.id=?1 AND m.client_id=?2 AND m.archived_at IS NULL AND p.archived_at IS NULL",params![resource.id,client],|r|r.get(0)).optional()?
        };
        if output.milestone_plan.is_none() {
            return Err(Error::Invalid("invalid_resource"));
        }
    } else {
        if !retained {
            let table = if resource.kind == "task" {
                "tasks"
            } else {
                "plans"
            };
            let valid:bool=tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1 AND client_id=?2 AND archived_at IS NULL)"),params![resource.id,client],|r|r.get(0))?;
            if !valid {
                return Err(Error::Invalid("invalid_resource"));
            }
        }
        if resource.kind == "task" {
            output.task = Some(resource.id.clone());
        } else {
            output.plan = Some(resource.id.clone());
        }
    }
    Ok(output)
}

fn snapshot(revision: i64, status: &str, scheduled: &str, zone: &str) -> Snapshot {
    Snapshot {
        reminder_status: Some(status.into()),
        reminder_scheduled_at: Some(scheduled.into()),
        reminder_timezone: Some(zone.into()),
        ..Snapshot::revision(revision)
    }
}
fn old_snapshot(value: &Value) -> Result<Snapshot> {
    Ok(snapshot(
        value["revision"].as_i64().ok_or(Error::Internal)?,
        value["status"].as_str().ok_or(Error::Internal)?,
        value["scheduled_at"].as_str().ok_or(Error::Internal)?,
        value["timezone"].as_str().ok_or(Error::Internal)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dst_folds_gaps_and_explicit_offsets_preserve_original_intent() {
        assert_eq!(
            schedule("2026-11-01T01:30:00.123456", "America/New_York", -14400)
                .unwrap()
                .0,
            "2026-11-01T05:30:00.123456Z"
        );
        assert_eq!(
            schedule("2026-11-01T01:30:00", "America/New_York", -18000)
                .unwrap()
                .0,
            "2026-11-01T06:30:00.000000Z"
        );
        assert!(schedule("2026-03-08T02:30:00", "America/New_York", -18000).is_err());
        assert!(schedule("2011-12-30T12:00:00", "Pacific/Apia", -36000).is_err());
        assert!(schedule("2026-01-01T00:00:00.1234567", "UTC", 0).is_err());
        assert!(schedule("2026-01-01T00:00:00", "Local", 0).is_err());
        assert_eq!(
            schedule("2026-01-01T00:00:00", "Asia/Kathmandu", 20700)
                .unwrap()
                .0,
            "2025-12-31T18:15:00.000000Z"
        );
        assert_eq!(
            schedule("2026-01-01T00:00:00.120000", "UTC", 0).unwrap().1,
            "2026-01-01T00:00:00.12"
        );
    }
}
