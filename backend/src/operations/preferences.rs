use super::*;
use crate::{
    audit::{self, Snapshot},
    db::Database,
    query::{next_revision, row_json},
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{Value, json};
fn document(tx: &Transaction<'_>, actor: &Actor) -> Result<Value> {
    let row=tx.query_row("SELECT workflow,tasks,finance,CAST(revision AS TEXT) AS revision FROM notification_preferences WHERE user_id=?1",[&actor.user_id],row_json).optional()?;
    Ok(match row {
        Some(v) => {
            json!({"workflow":v["workflow"]==1,"tasks":v["tasks"]==1,"finance":v["finance"]==1,"revision":v["revision"]})
        }
        None => json!({"workflow":true,"tasks":true,"finance":true,"revision":"1"}),
    })
}
pub async fn read(db: &Database, actor: Actor) -> Result<Value> {
    db.read(move |tx| {
        security::fresh(tx, &actor)?;
        document(tx, &actor)
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub workflow: bool,
    pub tasks: bool,
    pub finance: bool,
    pub expected_revision: String,
}
pub async fn update(db: &Database, actor: Actor, input: Preferences) -> Result<Value> {
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    db.write(move|tx|{security::fresh(tx,&actor)?;let old=document(tx,&actor)?;let previous=validation::exact_integer(old["revision"].as_str().ok_or(Error::Internal)?,true)?;let next=next_revision(previous,expected)?;
        tx.execute("INSERT INTO notification_preferences(user_id,workflow,tasks,finance,revision,updated_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(user_id) DO UPDATE SET workflow=excluded.workflow,tasks=excluded.tasks,finance=excluded.finance,revision=excluded.revision,updated_at=excluded.updated_at",params![actor.user_id,input.workflow,input.tasks,input.finance,next,validation::now()])?;
        audit::mutation(tx,&actor,"notification_preferences",&actor.user_id,None,"updated",(Some(Snapshot::revision(previous)),Snapshot::revision(next)))?;document(tx,&actor)
    }).await
}
pub async fn settings(db: &Database, actor: Actor) -> Result<Value> {
    db.read(move |tx| {
        security::fresh(tx, &actor)?;
        Ok(tx.query_row(
            "SELECT timezone,CAST(revision AS TEXT) AS revision FROM operation_settings WHERE id=1",
            [],
            row_json,
        )?)
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub timezone: String,
    pub expected_revision: String,
}
pub async fn update_settings(db: &Database, actor: Actor, input: Settings) -> Result<Value> {
    schedule::zone(&input.timezone)?;
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    db.write(move |tx| {
        security::require(tx, &actor, "settings.manage", None)?;
        let previous: i64 = tx.query_row(
            "SELECT revision FROM operation_settings WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        let next = next_revision(previous, expected)?;
        tx.execute(
            "UPDATE operation_settings SET timezone=?1,revision=?2,updated_at=?3 WHERE id=1",
            params![input.timezone, next, validation::now()],
        )?;
        // The singleton has no public UUID; attribute its audit marker to the operator identity.
        audit::mutation(
            tx,
            &actor,
            "operation_settings",
            &actor.user_id,
            None,
            "updated",
            (Some(Snapshot::revision(previous)), Snapshot::revision(next)),
        )?;
        Ok(json!({"timezone":input.timezone,"revision":next.to_string()}))
    })
    .await
}
