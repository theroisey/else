//! Durable SQLite admission and lifecycle fences. Network work never holds a
//! database transaction; each request and publication must recheck the lease.
use crate::{
    audit::{self, Event, Snapshot},
    credentials::{self, Binding, Envelope, Keyring},
    db::Database,
    error::{Error, Result},
    provider_credentials::{Credential, Crypto},
    security::{self, Actor},
    sync_period::Period,
    validation,
    vault::{self, Checkpoint, Scope, Vault},
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde::Serialize;
use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration as StdDuration, Instant},
};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct Synchronization {
    db: Database,
    vault: Vault,
    crypto: Crypto,
    ring: Keyring,
    stopped: Arc<AtomicBool>,
}
#[derive(Serialize)]
pub struct Queued {
    job_id: String,
    state: &'static str,
    connection_revision: String,
}
#[derive(Clone)]
pub struct Job {
    pub(crate) id: String,
    pub(crate) client: String,
    pub(crate) connection: String,
    pub(crate) requested_by: String,
    pub(crate) period: Period,
    pub(crate) connection_revision: i64,
    pub(crate) generation: i64,
    pub(crate) credential_revision: i64,
    pub(crate) state: String,
    pub(crate) attempts: i64,
    pub(crate) lease: Option<String>,
    pub(crate) lease_until: Option<String>,
    pub(crate) revision: i64,
    deadline: Option<Instant>,
}
impl fmt::Debug for Job {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[private provider job]")
    }
}
impl Synchronization {
    pub fn new(db: Database, vault: Vault, ring: Keyring) -> Self {
        Self {
            db,
            vault,
            ring,
            crypto: Crypto::default(),
            stopped: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn crypto(&self) -> &Crypto {
        &self.crypto
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
    pub async fn enqueue(
        &self,
        actor: Actor,
        scope: Scope,
        expected: i64,
        period: Period,
        plaintext: Option<Zeroizing<Vec<u8>>>,
    ) -> Result<Queued> {
        period.validate()?;
        if expected < 1 {
            return Err(Error::Invalid("invalid_request"));
        }
        let checkpoint = self.vault.inspect(actor.clone(), scope.clone()).await?;
        if checkpoint.provider != period.provider() {
            return Err(Error::NotFound);
        }
        if checkpoint.connection_revision != expected || expected >= i64::MAX - 1 {
            return Err(Error::Conflict("conflict"));
        }
        let prepared = if let Some(raw) = plaintext {
            // Syntax/key validation precedes reservation; no external call occurs.
            let validated = self
                .crypto
                .parse(period.provider().into(), Zeroizing::new(raw.to_vec()))
                .await;
            match validated {
                Ok(_) => {}
                Err(Error::Busy) => return Err(Error::Busy),
                Err(_) => return Err(Error::Invalid("invalid_request")),
            }
            Some(
                self.vault
                    .prepare(
                        actor.clone(),
                        scope.clone(),
                        checkpoint.clone(),
                        vault::Operation::Replace(raw),
                    )
                    .await?,
            )
        } else {
            if checkpoint.credential_revision == 0 {
                return Err(Error::Conflict("conflict"));
            }
            None
        };
        self.db.write(move|tx| {
            let changed=prepared.is_some();
            let mut current=if let Some(prepared)=prepared {vault::store(tx,&actor,&prepared)?} else {
                let current=vault::inspect(tx,&actor,&scope)?;
                if current!=checkpoint {return Err(Error::Conflict("conflict"));}current
            };
            let credential_generation:i64=tx.query_row("SELECT generation FROM integration_credentials WHERE connection_id=?1",[&scope.connection],|r|r.get(0))?;
            if current.provider!=period.provider()||credential_generation!=current.generation||current.credential_revision<1 {return Err(Error::Conflict("conflict"));}
            if changed {
                let mut statement=tx.prepare("SELECT id,revision FROM analytics_sync_jobs WHERE connection_id=?1 AND state IN ('queued','running') ORDER BY id")?;
                let cancelled=statement.query_map([&scope.connection],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
                for (id,revision) in cancelled {complete_job(tx,&id,revision,Some("connection_changed"))?;audit::mutation(tx,&actor,"analytics_sync",&id,Some(&scope.client),"updated",(Some(Snapshot::revision(revision)),Snapshot::revision(next(revision)?)))?;}
                let revision=next(current.connection_revision)?;
                tx.execute("UPDATE integration_connections SET state='pending',revision=?1,updated_at=max(updated_at,?2) WHERE id=?3",params![revision,validation::now(),scope.connection])?;
                audit::mutation(tx,&actor,"integration_connection",&scope.connection,Some(&scope.client),"updated",(Some(Snapshot::revision(current.connection_revision)),Snapshot::revision(revision)))?;
                current.connection_revision=revision;
            }
            insert_job(tx,&actor,&scope,&current,&period)
        }).await
    }
    pub async fn claim(&self) -> Result<Option<Job>> {
        self.claim_at(Utc::now()).await
    }
    async fn claim_at(&self, clock: DateTime<Utc>) -> Result<Option<Job>> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(Error::Busy);
        }
        let stopped = self.stopped.clone();
        self.db.write(move|tx| {
            if stopped.load(Ordering::Acquire) {return Err(Error::Busy);}
            let now=clock.to_rfc3339_opts(SecondsFormat::Micros,true);
            let running:i64=tx.query_row("SELECT count(*) FROM analytics_sync_jobs WHERE state='running' AND lease_until>?1",[&now],|r|r.get(0))?;
            if running>=2 {return Ok(None);}
            let Some(mut job)=tx.query_row(&format!("SELECT {JOB_FIELDS} FROM analytics_sync_jobs WHERE state='queued' OR (state='running' AND lease_until<=?1) ORDER BY created_at,id LIMIT 1"),[&now],row_job).optional()? else{return Ok(None);};
            let before=job.revision;let revision=next(before)?;
            let failure=invalidated(tx,&job)?.or(if job.attempts>=3 {Some("interrupted")} else {None});
            if let Some(reason)=failure {complete_job(tx,&job.id,before,Some(reason))?;job.state="failed".into();job.lease=None;job.lease_until=None;} else {
                let lease=validation::new_id();let lease_until=(clock+Duration::seconds(180)).to_rfc3339_opts(SecondsFormat::Micros,true);
                tx.execute("UPDATE analytics_sync_jobs SET state='running',attempts=attempts+1,lease_token=?1,lease_until=?2,revision=?3,updated_at=max(updated_at,?4) WHERE id=?5",params![lease,lease_until,revision,now,job.id])?;
                job.state="running".into();job.attempts+=1;job.lease=Some(lease);job.lease_until=Some(lease_until);
            }
            job.revision=revision;job.deadline=Some(Instant::now()+StdDuration::from_secs(150));system_event(tx,&job,"analytics_sync",&job.id,before,revision)?;if stopped.load(Ordering::Acquire) {return Err(Error::Busy);}Ok(Some(job))
        }).await
    }
    pub async fn fence(&self, job: Job) -> Result<()> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(Error::Busy);
        }
        let stopped = self.stopped.clone();
        self.db
            .read(move |tx| {
                if stopped.load(Ordering::Acquire) {
                    return Err(Error::Busy);
                }
                require_lease(tx, &job)
            })
            .await
    }
    pub async fn credential(&self, job: Job) -> Result<(String, Credential)> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(Error::Busy);
        }
        let ring = self.ring.clone();
        let target = job.clone();
        let (account,plaintext)=self.db.read(move|tx| {
            require_lease(tx,&target)?;
            let (account,raw):(String,Vec<u8>)=tx.query_row("SELECT c.provider_account_id,s.envelope FROM integration_connections c JOIN integration_credentials s ON s.connection_id=c.id WHERE c.id=?1",[&target.connection],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let binding=Binding{client:&target.client,connection:&target.connection,provider:target.period.provider(),purpose:credentials::purpose(target.period.provider())?};
            Ok((account,ring.open(&binding,&Envelope::parse(raw)?)?))
        }).await?;
        let credential = self
            .crypto
            .parse(job.period.provider().into(), plaintext)
            .await?;
        self.fence(job).await?;
        Ok((account, credential))
    }
    /// A failed collection never alters a connection or previous observations.
    /// Late/expired completions cannot even rewrite the job they no longer own.
    pub async fn fail(&self, job: Job) -> Result<()> {
        self.finish(job, None).await
    }
    pub async fn finish(
        &self,
        job: Job,
        workspace: Option<crate::providers::workspace::Workspace>,
    ) -> Result<()> {
        let raw = if let Some(workspace) = workspace {
            workspace.validate(&job.client, &job.connection, &job.period)?;
            Some(workspace.encode()?)
        } else {
            None
        };
        use sha2::{Digest, Sha256};
        let digest = raw
            .as_ref()
            .map(|raw| format!("{:x}", Sha256::digest(raw.as_bytes())));
        let stopped = self.stopped.clone();
        self.db
            .write(move |tx| {
                if stopped.load(Ordering::Acquire) {return Err(Error::Busy);}
                require_live_token(tx, &job)?;
                let reason=invalidated(tx,&job)?.or(if raw.is_none(){Some("provider_unavailable")}else{None});
                if reason.is_none() {
                    let [since,until,start,end,currency]=job.period.columns();
                    let saved:Option<(String,i64)>=tx.query_row("SELECT id,revision FROM analytics_snapshots WHERE client_id=?1 AND connection_id=?2 AND generation=?3 AND provider=?4 AND since IS ?5 AND until IS ?6 AND start_at IS ?7 AND end_at IS ?8 AND currency IS ?9",params![job.client,job.connection,job.generation,job.period.provider(),since,until,start,end,currency],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                    let (id,before)=saved.unwrap_or((validation::new_id(),0));let revision=next(before)?;let now=validation::now();
                    tx.execute("INSERT INTO analytics_snapshots(id,client_id,connection_id,generation,provider,since,until,start_at,end_at,currency,workspace,workspace_sha256,revision,synced_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,workspace_sha256=excluded.workspace_sha256,revision=excluded.revision,synced_at=excluded.synced_at",params![id,job.client,job.connection,job.generation,job.period.provider(),since,until,start,end,currency,raw,digest,revision,now])?;
                    let connection_revision=next(job.connection_revision)?;
                    tx.execute("UPDATE integration_connections SET state='connected',revision=?1,updated_at=max(updated_at,?2) WHERE id=?3",params![connection_revision,now,job.connection])?;
                    system_event(tx,&job,"analytics_snapshot",&id,before,revision)?;
                    system_event(tx,&job,"integration_connection",&job.connection,job.connection_revision,connection_revision)?;
                }
                complete_job(tx, &job.id, job.revision, reason)?;
                system_event(
                    tx,
                    &job,
                    "analytics_sync",
                    &job.id,
                    job.revision,
                    next(job.revision)?,
                )?;
                if stopped.load(Ordering::Acquire)||job.deadline.is_some_and(|d|Instant::now()>=d) {return Err(Error::Busy);}Ok(())
            })
            .await
    }
    pub async fn prune(&self) -> Result<usize> {
        self.db.write(move|tx| {
            let cutoff=(Utc::now()-Duration::days(90)).to_rfc3339_opts(SecondsFormat::Micros,true);
            let mut statement=tx.prepare("SELECT id,client_id,revision FROM analytics_snapshots WHERE synced_at<=?1 ORDER BY synced_at,id LIMIT 100")?;
            let expired=statement.query_map([cutoff],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            for (id,client,revision) in &expired {
                tx.execute("DELETE FROM analytics_snapshots WHERE id=?1",[id])?;
                audit::append(tx,Event{actor:None,request_id:&audit::request_id(),kind:"analytics_snapshot",id,client:Some(client),action:"deleted",before:Some(Snapshot::revision(*revision)),after:Some(Snapshot{exists:Some(false),..Default::default()}),source:"job"})?;
            }Ok(expired.len())
        }).await
    }
}
const JOB_FIELDS: &str = "id,client_id,connection_id,requested_by,provider,since,until,start_at,end_at,currency,connection_revision,generation,credential_revision,state,attempts,lease_token,lease_until,revision";
fn row_job(row: &Row<'_>) -> rusqlite::Result<Job> {
    let period = Period::stored(
        row.get(4)?,
        [
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
        ],
    )
    .map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(Job {
        id: row.get(0)?,
        client: row.get(1)?,
        connection: row.get(2)?,
        requested_by: row.get(3)?,
        period,
        connection_revision: row.get(10)?,
        generation: row.get(11)?,
        credential_revision: row.get(12)?,
        state: row.get(13)?,
        attempts: row.get(14)?,
        lease: row.get(15)?,
        lease_until: row.get(16)?,
        revision: row.get(17)?,
        deadline: None,
    })
}
fn next(value: i64) -> Result<i64> {
    value.checked_add(1).ok_or(Error::Conflict("conflict"))
}
fn insert_job(
    tx: &Transaction<'_>,
    actor: &Actor,
    scope: &Scope,
    current: &Checkpoint,
    period: &Period,
) -> Result<Queued> {
    let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM analytics_sync_jobs WHERE connection_id=?1 AND state IN ('queued','running'))",[&scope.connection],|r|r.get(0))?;
    if active {
        return Err(Error::Conflict("conflict"));
    }
    let id = validation::new_id();
    let [since, until, start, end, currency] = period.columns();
    let now = validation::now();
    tx.execute("INSERT INTO analytics_sync_jobs(id,client_id,connection_id,requested_by,provider,since,until,start_at,end_at,currency,connection_revision,generation,credential_revision,state,attempts,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'queued',0,1,?14,?14)",params![id,scope.client,scope.connection,actor.user_id,period.provider(),since,until,start,end,currency,current.connection_revision,current.generation,current.credential_revision,now])?;
    audit::mutation(
        tx,
        actor,
        "analytics_sync",
        &id,
        Some(&scope.client),
        "created",
        (
            Some(Snapshot {
                exists: Some(false),
                ..Default::default()
            }),
            Snapshot::revision(1),
        ),
    )?;
    Ok(Queued {
        job_id: id,
        state: "queued",
        connection_revision: current.connection_revision.to_string(),
    })
}
fn invalidated(tx: &Transaction<'_>, job: &Job) -> Result<Option<&'static str>> {
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM clients WHERE id=?1 AND archived_at IS NULL)",
        [&job.client],
        |r| r.get(0),
    )?;
    if !active
        || !security::allowed_user(tx, &job.requested_by, "clients.view", Some(&job.client))?
        || !security::allowed_user(
            tx,
            &job.requested_by,
            "integrations.manage",
            Some(&job.client),
        )?
    {
        return Ok(Some("authorization_required"));
    }
    let matches:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM integration_connections c JOIN integration_credentials s ON s.connection_id=c.id WHERE c.id=?1 AND c.client_id=?2 AND c.provider=?3 AND c.state IN ('pending','connected','reauthorization_required') AND c.revision=?4 AND c.generation=?5 AND s.generation=?5 AND s.revision=?6)",params![job.connection,job.client,job.period.provider(),job.connection_revision,job.generation,job.credential_revision],|r|r.get(0))?;
    Ok(if matches {
        None
    } else {
        Some("connection_changed")
    })
}
fn require_live_token(tx: &Transaction<'_>, job: &Job) -> Result<()> {
    if job.deadline.is_some_and(|d| Instant::now() >= d) {
        return Err(Error::Conflict("conflict"));
    }
    let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM analytics_sync_jobs WHERE id=?1 AND client_id=?2 AND connection_id=?3 AND state='running' AND lease_token=?4 AND lease_until>?5 AND revision=?6)",params![job.id,job.client,job.connection,job.lease,validation::now(),job.revision],|r|r.get(0))?;
    if valid && job.lease.is_some() {
        Ok(())
    } else {
        Err(Error::Conflict("conflict"))
    }
}
fn require_lease(tx: &Transaction<'_>, job: &Job) -> Result<()> {
    require_live_token(tx, job)?;
    if invalidated(tx, job)?.is_none() {
        Ok(())
    } else {
        Err(Error::Conflict("conflict"))
    }
}
fn complete_job(tx: &Transaction<'_>, id: &str, revision: i64, reason: Option<&str>) -> Result<()> {
    let now = validation::now();
    let affected=tx.execute("UPDATE analytics_sync_jobs SET state=CASE WHEN ?1 IS NULL THEN 'succeeded' ELSE 'failed' END,reason=?1,lease_token=NULL,lease_until=NULL,finished_at=?2,updated_at=max(updated_at,?2),revision=?3 WHERE id=?4 AND revision=?5",params![reason,now,next(revision)?,id,revision])?;
    if affected != 1 {
        return Err(Error::Conflict("conflict"));
    }
    Ok(())
}
fn system_event(
    tx: &Transaction<'_>,
    job: &Job,
    kind: &str,
    id: &str,
    before: i64,
    after: i64,
) -> Result<()> {
    audit::append(
        tx,
        Event {
            actor: None,
            request_id: &audit::request_id(),
            kind,
            id,
            client: Some(&job.client),
            action: if before == 0 { "created" } else { "updated" },
            before: Some(if before == 0 {
                Snapshot {
                    exists: Some(false),
                    ..Default::default()
                }
            } else {
                Snapshot::revision(before)
            }),
            after: Some(Snapshot::revision(after)),
            source: "job",
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{integrations, testing::Fixture};
    use base64::Engine;
    fn ring() -> Keyring {
        Keyring::parse(&serde_json::to_vec(&serde_json::json!({"active_key_id":"synthetic-one","keys":[{"id":"synthetic-one","key_base64":base64::engine::general_purpose::STANDARD.encode([0x6b;32])}]})).unwrap()).unwrap()
    }
    async fn fixture() -> (Fixture, Synchronization) {
        let f = Fixture::new().await;
        let ring = ring();
        let service =
            Synchronization::new(f.db.clone(), Vault::new(f.db.clone(), ring.clone()), ring);
        (f, service)
    }
    fn period() -> Period {
        Period::calendar("meta_ads", "2026-10-01", "2026-10-06").unwrap()
    }
    fn token() -> Option<Zeroizing<Vec<u8>>> {
        Some(Zeroizing::new(b"synthetic-private-meta-token".to_vec()))
    }
    fn empty_workspace(job: &Job) -> crate::providers::workspace::Workspace {
        use crate::providers::{meta, workspace::Workspace};
        let Period::Calendar { since, until, .. } = &job.period else {
            panic!("wrong period");
        };
        let stamp = crate::history_cursor::canonical(&validation::now()).unwrap();
        Workspace::Meta(Box::new(meta::Workspace {
            report: meta::Report {
                client_id: job.client.clone(),
                connection_id: job.connection.clone(),
                graph_version: "v26.0".into(),
                currency: "USD".into(),
                timezone: "Europe/Istanbul".into(),
                since: since.clone(),
                until: until.clone(),
                days: vec![],
                totals: meta::Metrics {
                    spend_decimal: "0".into(),
                    impressions: "0".into(),
                    clicks: "0".into(),
                    ctr_percent: None,
                    cpc_decimal: None,
                    cpm_decimal: None,
                },
                attribution_status: "unavailable".into(),
            },
            collected_from: stamp.clone(),
            collected_through: stamp,
        }))
    }
    #[tokio::test]
    #[ignore = "requires the disposable official Redis service from make test-cache"]
    async fn redis_reports_are_versioned_authenticated_and_optional_under_failure() {
        use crate::{cache::ReportCache, reports};
        let url = std::env::var("ELSE_TEST_REDIS_URL")
            .expect("ELSE_TEST_REDIS_URL must point to a disposable Redis database");
        let cache = ReportCache::new(Some(&url)).unwrap();
        let (f, s) = fixture().await;
        let scope = connection(&f, "6001").await;
        s.enqueue(f.actor.clone(), scope.clone(), 1, period(), token())
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        s.finish(job.clone(), Some(empty_workspace(&job)))
            .await
            .unwrap();
        let uncached = reports::read(&f.db, f.actor.clone(), scope.clone(), period())
            .await
            .unwrap();
        let first = reports::read_cached(&f.db, &cache, f.actor.clone(), scope.clone(), period())
            .await
            .unwrap();
        assert_eq!(first, uncached);
        let conn = f.connection();
        let key:String=conn.query_row("SELECT 'else:report:v1:'||id||':'||revision||':'||workspace_sha256 FROM analytics_snapshots",[],|r|r.get(0)).unwrap();
        let mut redis = redis::Client::open(url)
            .unwrap()
            .get_multiplexed_async_connection()
            .await
            .unwrap();
        let bytes: Vec<u8> = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut redis)
            .await
            .unwrap();
        assert!(!bytes.is_empty());
        let ttl: i64 = redis::cmd("TTL")
            .arg(&key)
            .query_async(&mut redis)
            .await
            .unwrap();
        assert!((1..=300).contains(&ttl));
        assert_eq!(
            reports::read_cached(&f.db, &cache, f.actor.clone(), scope.clone(), period())
                .await
                .unwrap(),
            uncached
        );
        let mut corrupted: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        corrupted["report"]["currency"] = "EUR".into();
        for corrupted in [
            serde_json::to_vec(&corrupted).unwrap(),
            b"malformed".to_vec(),
            vec![b'x'; crate::cache::MAX_REPORT + 100],
        ] {
            let _: String = redis::cmd("SET")
                .arg(&key)
                .arg(&corrupted)
                .query_async(&mut redis)
                .await
                .unwrap();
            assert_eq!(
                reports::read_cached(&f.db, &cache, f.actor.clone(), scope.clone(), period())
                    .await
                    .unwrap(),
                uncached
            );
            let restored: Vec<u8> = redis::cmd("GET")
                .arg(&key)
                .query_async(&mut redis)
                .await
                .unwrap();
            assert_eq!(restored, bytes);
        }
        // A newly published revision cannot reuse the previous cached bytes.
        s.enqueue(f.actor.clone(), scope.clone(), 4, period(), None)
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        let mut updated = empty_workspace(&job);
        if let crate::providers::workspace::Workspace::Meta(ref mut value) = updated {
            value.report.currency = "EUR".into();
        }
        s.finish(job, Some(updated)).await.unwrap();
        let current = reports::read_cached(&f.db, &cache, f.actor.clone(), scope.clone(), period())
            .await
            .unwrap();
        assert_eq!(current["data"]["report"]["currency"], "EUR");
        let _: String = redis::cmd("CLIENT")
            .arg("PAUSE")
            .arg(300)
            .arg("ALL")
            .query_async(&mut redis)
            .await
            .unwrap();
        let start = Instant::now();
        assert_eq!(
            reports::read_cached(&f.db, &cache, f.actor.clone(), scope.clone(), period())
                .await
                .unwrap(),
            current
        );
        assert!(start.elapsed() < StdDuration::from_millis(250));
        let start = Instant::now();
        assert_eq!(
            reports::read_cached(&f.db, &cache, f.actor.clone(), scope.clone(), period())
                .await
                .unwrap(),
            current
        );
        assert!(start.elapsed() < StdDuration::from_millis(150));
        conn.execute(
            "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='analytics.view'",
            [validation::now()],
        )
        .unwrap();
        assert!(matches!(
            reports::read_cached(&f.db, &cache, f.actor.clone(), scope.clone(), period()).await,
            Err(Error::NotFound)
        ));
        // Cache contains only report projections: no credentials or authority.
        let keys: Vec<String> = redis::cmd("KEYS")
            .arg("else:*")
            .query_async(&mut redis)
            .await
            .unwrap();
        assert!(keys.iter().all(|k| k.starts_with("else:report:v1:")));
        for key in keys {
            let raw: Vec<u8> = redis::cmd("GET")
                .arg(key)
                .query_async(&mut redis)
                .await
                .unwrap();
            let raw = String::from_utf8(raw).unwrap();
            assert!(
                !raw.contains("synthetic-private")
                    && !raw.contains("account_id")
                    && !raw.contains("session")
            );
        }
    }
    #[tokio::test]
    async fn publication_and_its_audits_commit_together_and_failed_refresh_preserves_observations()
    {
        let (f, s) = fixture().await;
        let scope = connection(&f, "5001").await;
        s.enqueue(f.actor.clone(), scope.clone(), 1, period(), token())
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        f.connection().execute_batch("CREATE TRIGGER synthetic_publish_audit_failure BEFORE INSERT ON audit_events WHEN NEW.resource_kind='analytics_snapshot' BEGIN SELECT RAISE(ABORT,'synthetic'); END").unwrap();
        assert!(
            s.finish(job.clone(), Some(empty_workspace(&job)))
                .await
                .is_err()
        );
        let conn = f.connection();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT count(*) FROM analytics_snapshots", [], |r| r
                .get(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row::<String, _, _>("SELECT state FROM analytics_sync_jobs", [], |r| r
                .get(0))
                .unwrap(),
            "running"
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT revision FROM integration_connections", [], |r| r
                .get(0))
                .unwrap(),
            3
        );
        conn.execute_batch("DROP TRIGGER synthetic_publish_audit_failure")
            .unwrap();
        s.finish(job.clone(), Some(empty_workspace(&job)))
            .await
            .unwrap();
        let original: (String, i64) = conn
            .query_row("SELECT id,revision FROM analytics_snapshots", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(original.1, 1);
        let view = crate::reports::read(&f.db, f.actor.clone(), scope.clone(), period())
            .await
            .unwrap();
        assert_eq!(view["status"]["state"], "succeeded");
        assert_eq!(view["status"]["stale"], false);
        assert!(view["data"].is_object());
        s.enqueue(f.actor.clone(), scope.clone(), 4, period(), None)
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        s.finish(job.clone(), Some(empty_workspace(&job)))
            .await
            .unwrap();
        let refreshed: (String, i64) = conn
            .query_row("SELECT id,revision FROM analytics_snapshots", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(refreshed, (original.0, 2));
        s.enqueue(f.actor.clone(), scope.clone(), 5, period(), None)
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        s.fail(job).await.unwrap();
        let view = crate::reports::read(&f.db, f.actor.clone(), scope.clone(), period())
            .await
            .unwrap();
        assert_eq!(view["status"]["state"], "failed");
        assert_eq!(view["status"]["reason"], "provider_unavailable");
        assert!(view["data"].is_object());
        let list = crate::reports::list(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            None,
            "meta_ads".into(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(list["data"].as_array().unwrap().len(), 1);
        assert_eq!(list["data"][0].as_object().unwrap().len(), 7);
        conn.execute(
            "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='analytics.view'",
            [validation::now()],
        )
        .unwrap();
        assert!(
            crate::reports::read(&f.db, f.actor.clone(), scope, period())
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn late_publication_fails_after_authority_or_credential_changes_and_shutdown() {
        let (f, s) = fixture().await;
        let scope = connection(&f, "6001").await;
        s.enqueue(f.actor.clone(), scope.clone(), 1, period(), token())
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        let checkpoint = s
            .vault
            .inspect(f.actor.clone(), scope.clone())
            .await
            .unwrap();
        let prepared = s
            .vault
            .prepare(
                f.actor.clone(),
                scope.clone(),
                checkpoint,
                vault::Operation::Rewrap,
            )
            .await
            .unwrap();
        s.vault.persist(f.actor.clone(), prepared).await.unwrap();
        assert!(s.fence(job.clone()).await.is_err());
        s.finish(job.clone(), Some(empty_workspace(&job)))
            .await
            .unwrap();
        let conn = f.connection();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT count(*) FROM analytics_snapshots", [], |r| r
                .get(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row::<String, _, _>("SELECT reason FROM analytics_sync_jobs", [], |r| r
                .get(0))
                .unwrap(),
            "connection_changed"
        );
        s.enqueue(f.actor.clone(), scope.clone(), 4, period(), None)
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        conn.execute(
            "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='integrations.manage'",
            [validation::now()],
        )
        .unwrap();
        s.finish(job.clone(), Some(empty_workspace(&job)))
            .await
            .unwrap();
        assert_eq!(
            conn.query_row::<String, _, _>(
                "SELECT reason FROM analytics_sync_jobs WHERE id=?1",
                [job.id],
                |r| r.get(0)
            )
            .unwrap(),
            "authorization_required"
        );
        let (f, s) = fixture().await;
        let scope = connection(&f, "6002").await;
        s.enqueue(f.actor.clone(), scope, 1, period(), token())
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        s.stop();
        assert!(
            s.finish(job.clone(), Some(empty_workspace(&job)))
                .await
                .is_err()
        );
        assert!(s.claim().await.is_err());
        assert_eq!(
            f.connection()
                .query_row::<String, _, _>("SELECT state FROM analytics_sync_jobs", [], |r| r
                    .get(0))
                .unwrap(),
            "running"
        );
    }
    async fn connection(f: &Fixture, account: &str) -> Scope {
        let value = integrations::create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            "meta_ads".into(),
            account.into(),
        )
        .await
        .unwrap();
        Scope {
            client: f.client.clone(),
            connection: value["id"].as_str().unwrap().into(),
            website: None,
        }
    }
    #[tokio::test]
    async fn setup_is_local_and_atomic_and_replacement_invalidates_previous_jobs() {
        let (f, s) = fixture().await;
        let scope = connection(&f, "1001").await;
        let first = s
            .enqueue(f.actor.clone(), scope.clone(), 1, period(), token())
            .await
            .unwrap();
        assert_eq!(first.connection_revision, "3");
        let old = s.claim().await.unwrap().unwrap();
        assert!(s.fence(old.clone()).await.is_ok());
        let (account, credential) = s.credential(old.clone()).await.unwrap();
        assert_eq!(account, "1001");
        assert_eq!(format!("{credential:?}"), "[private provider credential]");
        assert!(matches!(
            s.enqueue(f.actor.clone(), scope.clone(), 3, period(), None)
                .await,
            Err(Error::Conflict(_))
        ));
        let second = s
            .enqueue(f.actor.clone(), scope.clone(), 3, period(), token())
            .await
            .unwrap();
        assert_ne!(first.job_id, second.job_id);
        assert_eq!(second.connection_revision, "5");
        assert!(s.fence(old.clone()).await.is_err());
        assert!(s.fail(old).await.is_err());
        let saved: (String, String) = f
            .connection()
            .query_row(
                "SELECT state,reason FROM analytics_sync_jobs WHERE id=?1",
                [first.job_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(saved, ("failed".into(), "connection_changed".into()));
        assert!(
            s.enqueue(
                f.actor.clone(),
                scope.clone(),
                5,
                period(),
                Some(Zeroizing::new(b"unsafe token".to_vec()))
            )
            .await
            .is_err()
        );
        assert_eq!(
            f.connection()
                .query_row::<i64, _, _>(
                    "SELECT reservations FROM integration_encryption_keys",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
            2
        );
        let new = s.claim().await.unwrap().unwrap();
        s.fail(new).await.unwrap();
        let third = s
            .enqueue(f.actor.clone(), scope.clone(), 5, period(), None)
            .await
            .unwrap();
        assert_eq!(third.connection_revision, "5");
        assert!(f.connection().execute("UPDATE analytics_sync_jobs SET requested_by=?1,revision=revision+1 WHERE id=?2",params![validation::new_id(),third.job_id]).is_err());
        assert!(
            f.connection()
                .execute(
                    "DELETE FROM analytics_sync_jobs WHERE id=?1",
                    [third.job_id]
                )
                .is_err()
        );
        let audit: String = f
            .connection()
            .query_row(
                "SELECT group_concat(before_state||after_state||metadata) FROM audit_events",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!audit.contains("private-meta-token"));
        assert!(!audit.contains("1001"));
    }
    #[tokio::test]
    async fn claims_are_durable_bounded_and_expired_tokens_cannot_complete_recovered_work() {
        let (f, s) = fixture().await;
        for account in ["2001", "2002", "2003"] {
            let scope = connection(&f, account).await;
            s.enqueue(f.actor.clone(), scope, 1, period(), token())
                .await
                .unwrap();
        }
        let (a, b, c) = tokio::join!(s.claim(), s.claim(), s.claim());
        let jobs = vec![a.unwrap(), b.unwrap(), c.unwrap()];
        assert_eq!(jobs.iter().flatten().count(), 2);
        assert!(s.claim().await.unwrap().is_none());
        let previous = jobs
            .into_iter()
            .flatten()
            .min_by_key(|j| j.id.clone())
            .unwrap();
        let first_created_id: String = f
            .connection()
            .query_row(
                "SELECT id FROM analytics_sync_jobs ORDER BY created_at,id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let clock = Utc::now() + Duration::seconds(181);
        let recovered = s.claim_at(clock).await.unwrap().unwrap();
        assert_eq!(recovered.id, first_created_id);
        assert_eq!(recovered.attempts, 2);
        if recovered.id == previous.id {
            assert!(s.fence(previous.clone()).await.is_err());
            assert!(s.fail(previous).await.is_err());
        }
        let old = recovered.clone();
        let third = s
            .claim_at(clock + Duration::seconds(181))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(third.id, recovered.id);
        assert_eq!(third.attempts, 3);
        assert_ne!(old.lease, third.lease);
        assert!(s.fence(old.clone()).await.is_err());
        assert!(s.fail(old).await.is_err());
        let exhausted = s
            .claim_at(clock + Duration::seconds(362))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exhausted.id, third.id);
        assert_eq!(exhausted.state, "failed");
        assert!(exhausted.lease.is_none());
        let reason: String = f
            .connection()
            .query_row(
                "SELECT reason FROM analytics_sync_jobs WHERE id=?1",
                [exhausted.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(reason, "interrupted");
    }
    #[tokio::test]
    async fn revocation_and_local_disable_are_checked_at_request_and_failure_boundaries() {
        let (f, s) = fixture().await;
        let scope = connection(&f, "3001").await;
        s.enqueue(f.actor.clone(), scope.clone(), 1, period(), token())
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        f.connection().execute("UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='integrations.manage'",[validation::now()]).unwrap();
        assert!(s.fence(job.clone()).await.is_err());
        assert!(s.credential(job.clone()).await.is_err());
        s.fail(job.clone()).await.unwrap();
        assert_eq!(
            f.connection()
                .query_row::<String, _, _>(
                    "SELECT reason FROM analytics_sync_jobs WHERE id=?1",
                    [job.id],
                    |r| r.get(0)
                )
                .unwrap(),
            "authorization_required"
        );
        let (f, s) = fixture().await;
        let scope = connection(&f, "3002").await;
        s.enqueue(f.actor.clone(), scope.clone(), 1, period(), token())
            .await
            .unwrap();
        let job = s.claim().await.unwrap().unwrap();
        integrations::disconnect(
            &f.db,
            f.actor.clone(),
            scope,
            validation::json(br#"{"revision":"3","confirmed":true}"#).unwrap(),
        )
        .await
        .unwrap();
        assert!(s.fence(job.clone()).await.is_err());
        s.fail(job.clone()).await.unwrap();
        assert_eq!(
            f.connection()
                .query_row::<String, _, _>(
                    "SELECT reason FROM analytics_sync_jobs WHERE id=?1",
                    [job.id],
                    |r| r.get(0)
                )
                .unwrap(),
            "connection_changed"
        );
    }
    #[tokio::test]
    async fn mandatory_audit_failure_rolls_back_setup_or_claim_without_refunding_nonce_capacity() {
        let (f, s) = fixture().await;
        let scope = connection(&f, "4001").await;
        f.connection().execute_batch("CREATE TRIGGER synthetic_sync_audit_failure BEFORE INSERT ON audit_events WHEN NEW.resource_kind='analytics_sync' BEGIN SELECT RAISE(ABORT,'synthetic'); END").unwrap();
        assert!(
            s.enqueue(f.actor.clone(), scope.clone(), 1, period(), token())
                .await
                .is_err()
        );
        let conn = f.connection();
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT reservations FROM integration_encryption_keys",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT count(*) FROM integration_credentials", [], |r| r
                .get(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT revision FROM integration_connections", [], |r| r
                .get(0))
                .unwrap(),
            1
        );
        conn.execute_batch("DROP TRIGGER synthetic_sync_audit_failure")
            .unwrap();
        s.enqueue(f.actor.clone(), scope, 1, period(), token())
            .await
            .unwrap();
        conn.execute_batch("CREATE TRIGGER synthetic_sync_audit_failure BEFORE INSERT ON audit_events WHEN NEW.resource_kind='analytics_sync' BEGIN SELECT RAISE(ABORT,'synthetic'); END").unwrap();
        assert!(s.claim().await.is_err());
        let state: (String, i64, i64) = conn
            .query_row(
                "SELECT state,revision,attempts FROM analytics_sync_jobs",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, ("queued".into(), 1, 0));
    }
}
