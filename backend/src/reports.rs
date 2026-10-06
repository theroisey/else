//! Fresh authorized reads of complete, current-generation durable observations.
use crate::{
    db::Database,
    error::{Error, Result},
    integrations,
    providers::workspace::Workspace,
    query::row_json,
    security::Actor,
    sync_period::Period,
    validation,
    vault::Scope,
    websites,
};
use chrono::{Duration, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Serialize)]
struct Status {
    job_id: Option<String>,
    state: String,
    reason: Option<String>,
    updated_at: Option<String>,
    synced_at: Option<String>,
    stale: bool,
}
pub async fn list(
    db: &Database,
    actor: Actor,
    client: String,
    website: Option<String>,
    provider: String,
    after: Option<String>,
) -> Result<Value> {
    if !matches!(provider.as_str(), "ga4" | "meta_ads" | "woocommerce") {
        return Err(Error::Invalid("invalid_request"));
    }
    db.read(move|tx| {
        integrations::authorize(tx,&actor,&client,"analytics.view",true)?;
        if let Some(website)=&website {let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM client_websites WHERE id=?1 AND client_id=?2)",params![website,client],|r|r.get(0))?;if !exists {return Err(Error::NotFound);}}
        let mut stmt=tx.prepare("SELECT id,client_id,provider,state,CAST(revision AS TEXT) AS revision,created_at,updated_at FROM integration_connections c WHERE client_id=?1 AND provider=?2 AND (?3 IS NULL OR id>?3) AND (?4 IS NULL OR EXISTS(SELECT 1 FROM website_integrations w WHERE w.connection_id=c.id AND w.website_id=?4 AND w.client_id=?1)) ORDER BY id LIMIT 26")?;
        let mut data=stmt.query_map(params![client,provider,after,website],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;let more=data.len()>25;data.truncate(25);
        Ok(json!({"next_id":if more {data.last().and_then(|d|d["id"].as_str())}else{None},"data":data}))
    }).await
}
pub async fn read(db: &Database, actor: Actor, scope: Scope, period: Period) -> Result<Value> {
    read_cached(
        db,
        &crate::cache::ReportCache::default(),
        actor,
        scope,
        period,
    )
    .await
}

/// A cache hit avoids loading the SQLite report blob, but a second fresh SQL
/// snapshot must still authorize it and select exactly the same report revision.
pub async fn read_cached(
    db: &Database,
    cache: &crate::cache::ReportCache,
    actor: Actor,
    scope: Scope,
    period: Period,
) -> Result<Value> {
    period.validate()?;
    let initial = select_async(db, actor.clone(), scope.clone(), period.clone()).await?;
    if let Some(snapshot) = &initial.snapshot {
        let key = snapshot.key();
        if let Some(raw) = cache.get(&key).await
            && snapshot.matches(&raw)
            && let Ok(workspace) =
                Workspace::decode(&raw, &scope.client, &scope.connection, &period)
        {
            let current = select_async(db, actor.clone(), scope.clone(), period.clone()).await?;
            if current.snapshot == initial.snapshot {
                return Ok(current.reply(Some(workspace)));
            }
        }
    } else {
        return Ok(initial.reply(None));
    }
    let (selected, raw, workspace) = db
        .read(move |tx| {
            let selected = select(tx, &actor, &scope, &period)?;
            if let Some(snapshot) = &selected.snapshot {
                let raw: String = tx.query_row(
                    "SELECT workspace FROM analytics_snapshots WHERE id=?1 AND revision=?2",
                    params![snapshot.id, snapshot.revision],
                    |row| row.get(0),
                )?;
                if !snapshot.matches(raw.as_bytes()) {
                    return Err(Error::Internal);
                }
                let workspace =
                    Workspace::decode(raw.as_bytes(), &scope.client, &scope.connection, &period)?;
                Ok((selected, Some(raw), Some(workspace)))
            } else {
                Ok((selected, None, None))
            }
        })
        .await?;
    if let (Some(snapshot), Some(raw)) = (&selected.snapshot, &raw) {
        cache.put(&snapshot.key(), raw.as_bytes()).await;
    }
    Ok(selected.reply(workspace))
}
#[derive(PartialEq, Eq)]
struct SnapshotKey {
    id: String,
    revision: i64,
    digest: String,
    synced_at: String,
}
impl SnapshotKey {
    fn key(&self) -> String {
        format!(
            "else:report:v1:{}:{}:{}",
            self.id, self.revision, self.digest
        )
    }
    fn matches(&self, raw: &[u8]) -> bool {
        use sha2::{Digest, Sha256};
        raw.len() <= crate::cache::MAX_REPORT && format!("{:x}", Sha256::digest(raw)) == self.digest
    }
}
struct Selected {
    snapshot: Option<SnapshotKey>,
    status: Status,
}
impl Selected {
    fn reply(self, workspace: Option<Workspace>) -> Value {
        json!({"status":self.status,"data":workspace})
    }
}
async fn select_async(
    db: &Database,
    actor: Actor,
    scope: Scope,
    period: Period,
) -> Result<Selected> {
    db.read(move |tx| select(tx, &actor, &scope, &period)).await
}
fn select(
    tx: &rusqlite::Transaction<'_>,
    actor: &Actor,
    scope: &Scope,
    period: &Period,
) -> Result<Selected> {
    integrations::authorize(tx, actor, &scope.client, "analytics.view", true)?;
    if let Some(website) = &scope.website {
        websites::check_binding(tx, actor, &scope.client, website, &scope.connection, false)?;
    }
    let (generation,state):(i64,String)=tx.query_row("SELECT generation,state FROM integration_connections WHERE id=?1 AND client_id=?2 AND provider=?3",params![scope.connection,scope.client,period.provider()],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let [since, until, start, end, currency] = period.columns();
    let job:Option<(String,String,Option<String>,String)>=tx.query_row("SELECT id,state,reason,updated_at FROM analytics_sync_jobs WHERE client_id=?1 AND connection_id=?2 AND generation=?3 AND provider=?4 AND since IS ?5 AND until IS ?6 AND start_at IS ?7 AND end_at IS ?8 AND currency IS ?9 ORDER BY created_at DESC,id DESC LIMIT 1",params![scope.client,scope.connection,generation,period.provider(),since,until,start,end,currency],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let mut status = Status {
        job_id: None,
        state: "not_synced".into(),
        reason: None,
        updated_at: None,
        synced_at: None,
        stale: true,
    };
    if let Some((id, state, reason, time)) = job {
        validation::id(&id).map_err(|_| Error::Internal)?;
        status.job_id = Some(id);
        status.state = state;
        status.reason = reason;
        status.updated_at = Some(time);
    }
    let clock = Utc::now();
    let cutoff = (clock - Duration::days(90)).to_rfc3339_opts(SecondsFormat::Micros, true);
    let snapshot = if state == "connected" {
        tx.query_row("SELECT id,revision,workspace_sha256,synced_at FROM analytics_snapshots WHERE client_id=?1 AND connection_id=?2 AND generation=?3 AND provider=?4 AND since IS ?5 AND until IS ?6 AND start_at IS ?7 AND end_at IS ?8 AND currency IS ?9 AND synced_at>?10",params![scope.client,scope.connection,generation,period.provider(),since,until,start,end,currency,cutoff],|r|Ok(SnapshotKey{id:r.get(0)?,revision:r.get(1)?,digest:r.get(2)?,synced_at:r.get(3)?})).optional()?
    } else {
        None
    };
    if let Some(snapshot) = &snapshot {
        let synced = chrono::DateTime::parse_from_rfc3339(&snapshot.synced_at)
            .map_err(|_| Error::Internal)?;
        status.stale = clock - synced.with_timezone(&Utc) >= Duration::hours(24);
        status.synced_at = Some(snapshot.synced_at.clone());
    }
    Ok(Selected { snapshot, status })
}
