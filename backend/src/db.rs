use crate::{
    error::{Error, Result},
    validation,
};
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::{
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;

pub(crate) const SCHEMA: &str = include_str!("../migrations/sqlite/000001_initial.sql");
pub const ADMIN_ROLE: &str = "00000000-0000-4000-8000-000000000001";
const CONNECTIONS: usize = 8;

#[derive(Clone)]
pub struct Database(Arc<Pool>);

struct Pool {
    connections: Mutex<Vec<Connection>>,
    slots: Arc<Semaphore>,
    writer: Arc<Semaphore>,
}

struct Checkout {
    connection: Option<Connection>,
    pool: Arc<Pool>,
}

impl Drop for Checkout {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take()
            && let Ok(mut available) = self.pool.connections.lock()
        {
            available.push(connection);
        }
    }
}

impl Database {
    /// Startup is synchronous before the Pingora runtimes accept requests.
    pub fn open(path: &Path, seed: bool) -> Result<Self> {
        let parent = path.parent().ok_or(Error::Internal)?;
        if parent
            .join(".control/restore-pending.json")
            .symlink_metadata()
            .is_ok()
        {
            return Err(Error::Conflict("restore_incomplete"));
        }
        if seed && !path.exists() && legacy_present(parent) {
            return legacy_error();
        }
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(|_| Error::Internal)?;
        let mut first = connection(path)?;
        first.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&mut first)?;
        if seed {
            guard_legacy(&first, parent)?;
            seed_catalog(&mut first)?;
        }
        let mut connections = vec![first];
        for _ in 1..CONNECTIONS {
            connections.push(connection(path)?);
        }
        Ok(Self(Arc::new(Pool {
            connections: Mutex::new(connections),
            slots: Arc::new(Semaphore::new(CONNECTIONS)),
            writer: Arc::new(Semaphore::new(1)),
        })))
    }

    pub async fn read<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        self.run(false, operation).await
    }

    pub async fn write<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        self.run(true, operation).await
    }

    async fn run<T, F>(&self, write: bool, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        let writer = if write {
            Some(
                tokio::time::timeout(
                    Duration::from_secs(2),
                    self.0.writer.clone().acquire_owned(),
                )
                .await
                .map_err(|_| Error::Busy)?
                .map_err(|_| Error::Busy)?,
            )
        } else {
            None
        };
        let slot =
            tokio::time::timeout(Duration::from_secs(2), self.0.slots.clone().acquire_owned())
                .await
                .map_err(|_| Error::Busy)?
                .map_err(|_| Error::Busy)?;
        let pool = self.0.clone();
        tokio::task::spawn_blocking(move || {
            // Permits belong to actual work, including when the HTTP future is cancelled.
            let _writer = writer;
            let _slot = slot;
            let connection = pool
                .connections
                .lock()
                .map_err(|_| Error::Internal)?
                .pop()
                .ok_or(Error::Internal)?;
            let mut checkout = Checkout {
                connection: Some(connection),
                pool,
            };
            let connection = checkout.connection.as_mut().ok_or(Error::Internal)?;
            connection.pragma_update(None, "query_only", !write)?;
            if write {
                connection.query_row("SELECT begin_transaction_token()", [], |r| {
                    r.get::<_, String>(0)
                })?;
            }
            let transaction = connection.transaction_with_behavior(if write {
                TransactionBehavior::Immediate
            } else {
                TransactionBehavior::Deferred
            })?;
            let output = operation(&transaction)?;
            if write {
                validate_new_history(&transaction)?;
            }
            transaction.commit()?;
            Ok(output)
        })
        .await
        .map_err(|_| Error::Internal)?
    }

    pub async fn ready(&self) -> Result<()> {
        self.read(|tx| {
            tx.query_row("SELECT 1", [], |_| Ok(()))?;
            Ok(())
        })
        .await
    }
}

pub fn connection(path: &Path) -> Result<Connection> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file.sync_all().map_err(|_| Error::Internal)?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err(Error::Internal),
    }
    existing_private_file(path)?;
    configure_connection(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?)
}

/// Verified recovery sources are immutable and may be mounted read-only. Never
/// attempt file creation or acquire SQLite write access to the source bundle.
pub(crate) fn readonly_connection(path: &Path) -> Result<Connection> {
    existing_private_file(path)?;
    let connection = configure_connection(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?)?;
    connection.pragma_update(None, "query_only", "ON")?;
    Ok(connection)
}

fn existing_private_file(path: &Path) -> Result<()> {
    let metadata = path.symlink_metadata().map_err(|_| Error::Internal)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
    {
        return Err(Error::Internal);
    }
    Ok(())
}

fn configure_connection(connection: Connection) -> Result<Connection> {
    connection.busy_timeout(Duration::from_secs(2))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    connection.pragma_update(None, "wal_autocheckpoint", 1000)?;
    let token = Arc::new(Mutex::new(validation::new_id()));
    let current = token.clone();
    let flags = rusqlite::functions::FunctionFlags::SQLITE_UTF8;
    connection.create_scalar_function(
        "transaction_token",
        0,
        flags | rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS,
        move |_| {
            current.lock().map(|v| v.clone()).map_err(|_| {
                rusqlite::Error::UserFunctionError(Box::new(std::io::Error::other(
                    "transaction token unavailable",
                )))
            })
        },
    )?;
    connection.create_scalar_function(
        "begin_transaction_token",
        0,
        flags | rusqlite::functions::FunctionFlags::SQLITE_DIRECTONLY,
        move |_| {
            let mut current = token.lock().map_err(|_| {
                rusqlite::Error::UserFunctionError(Box::new(std::io::Error::other(
                    "transaction token unavailable",
                )))
            })?;
            *current = validation::new_id();
            Ok(current.clone())
        },
    )?;
    connection.create_scalar_function(
        "unicode_lower",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
            | rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| Ok(ctx.get::<String>(0)?.to_lowercase()),
    )?;
    connection.create_scalar_function(
        "integration_account_valid",
        2,
        flags
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
            | rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| {
            Ok(crate::integration_catalog::valid_account(
                &ctx.get::<String>(0)?,
                &ctx.get::<String>(1)?,
            ))
        },
    )?;
    connection.create_scalar_function(
        "audit_payload_valid",
        4,
        flags
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
            | rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| {
            Ok(crate::audit::storage_payload(
                &ctx.get::<String>(0)?,
                &ctx.get::<String>(1)?,
                &ctx.get::<String>(2)?,
                &ctx.get::<String>(3)?,
            ))
        },
    )?;
    Ok(connection)
}

pub(crate) fn validate_new_history(tx: &Transaction<'_>) -> Result<()> {
    validate_history(tx, true)
}
pub(crate) fn validate_history(tx: &Transaction<'_>, new_only: bool) -> Result<()> {
    let versions = if new_only {
        "v.creation_token=transaction_token()"
    } else {
        "1=1"
    };
    let snapshots = if new_only {
        "s.creation_token=transaction_token()"
    } else {
        "1=1"
    };
    // A parameterized OR forces a scan of ALL retained agreements on every
    // task/session write. These trusted predicates keep normal validation on
    // the creation-token indexes and retain complete verification for recovery.
    let invalid:bool=tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM pricing_versions v WHERE {versions} AND ((SELECT count(*) FROM pricing_lines WHERE version_id=v.id) NOT BETWEEN 1 AND 50 OR (SELECT min(position) FROM pricing_lines WHERE version_id=v.id)<>1 OR (SELECT max(position) FROM pricing_lines WHERE version_id=v.id)<>(SELECT count(*) FROM pricing_lines WHERE version_id=v.id) OR v.base_minor<>(SELECT sum(base_minor) FROM pricing_lines WHERE version_id=v.id) OR v.discount_minor<>(SELECT sum(discount_minor) FROM pricing_lines WHERE version_id=v.id) OR v.net_minor<>(SELECT sum(net_minor) FROM pricing_lines WHERE version_id=v.id) OR v.tax_minor<>(SELECT sum(tax_minor) FROM pricing_lines WHERE version_id=v.id) OR v.total_minor<>(SELECT sum(total_minor) FROM pricing_lines WHERE version_id=v.id) OR v.cost_minor IS NOT (SELECT CASE WHEN count(cost_minor)=count(*) THEN sum(cost_minor) END FROM pricing_lines WHERE version_id=v.id)))"),[],|r|r.get(0))?;
    if invalid {
        return Err(Error::Internal);
    }
    let invalid:bool=tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM pricing_snapshots s JOIN pricing_versions v ON v.id=s.version_id WHERE {snapshots} AND (s.title<>v.title OR s.base_minor<>v.base_minor OR s.discount_minor<>v.discount_minor OR s.net_minor<>v.net_minor OR s.tax_minor<>v.tax_minor OR s.total_minor<>v.total_minor OR s.total_minor<>(SELECT amount_minor FROM collections WHERE id=s.collection_id) OR (SELECT count(*) FROM pricing_snapshot_lines WHERE collection_id=s.collection_id)<>(SELECT count(*) FROM pricing_lines WHERE version_id=v.id) OR EXISTS(SELECT 1 FROM pricing_snapshot_lines l WHERE l.collection_id=s.collection_id AND NOT EXISTS(SELECT 1 FROM pricing_lines p WHERE p.version_id=v.id AND p.position=l.position AND p.description=l.description AND p.kind=l.kind AND p.frequency=l.frequency AND p.quantity_micros=l.quantity_micros AND p.unit_price_minor=l.unit_price_minor AND p.discount_bps=l.discount_bps AND p.tax_bps=l.tax_bps AND p.base_minor=l.base_minor AND p.discount_minor=l.discount_minor AND p.net_minor=l.net_minor AND p.tax_minor=l.tax_minor AND p.total_minor=l.total_minor))))"),[],|r|r.get(0))?;
    if invalid {
        return Err(Error::Internal);
    }
    Ok(())
}

fn migrate(connection: &mut Connection) -> Result<()> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;")?;
    let version: i64 = tx.query_row(
        "SELECT coalesce(max(version),0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?;
    let digest = format!("{:x}", Sha256::digest(SCHEMA));
    match version {
        0 => {
            tx.execute_batch(SCHEMA)?;
            for table in [
                "pricing_versions",
                "pricing_lines",
                "pricing_snapshots",
                "pricing_snapshot_lines",
            ] {
                // Identifiers are compile-time allowlisted, never request input.
                tx.execute_batch(&format!("CREATE TRIGGER {table}_no_update BEFORE UPDATE ON {table} BEGIN SELECT RAISE(ABORT,'immutable history'); END; CREATE TRIGGER {table}_no_delete BEFORE DELETE ON {table} BEGIN SELECT RAISE(ABORT,'immutable history'); END;"))?;
            }
            tx.execute(
                "INSERT INTO schema_migrations VALUES (1,?1,?2)",
                params![digest, validation::now()],
            )?;
        }
        1 => {
            let stored: String = tx.query_row(
                "SELECT sha256 FROM schema_migrations WHERE version=1",
                [],
                |r| r.get(0),
            )?;
            if stored != digest {
                return Err(Error::Internal);
            }
        }
        _ => return Err(Error::Internal),
    }
    tx.commit()?;
    Ok(())
}

fn guard_legacy(connection: &Connection, directory: &Path) -> Result<()> {
    if legacy_present(directory) {
        let imported: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM import_receipts WHERE source='postgresql')",
            [],
            |r| r.get(0),
        )?;
        if !imported {
            return legacy_error();
        }
    }
    Ok(())
}

pub(crate) fn legacy_present(directory: &Path) -> bool {
    ["18/docker/PG_VERSION", "postgres/PG_VERSION", "PG_VERSION"]
        .iter()
        .any(|p| directory.join(p).exists())
}
fn legacy_error<T>() -> Result<T> {
    tracing::error!(
        code = "legacy_import_required",
        "Legacy database detected; follow the explicit data migration procedure."
    );
    Err(Error::Conflict("legacy_import_required"))
}

fn seed_catalog(connection: &mut Connection) -> Result<()> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let count: i64 = tx.query_row("SELECT count(*) FROM roles", [], |r| r.get(0))?;
    if count != 0 {
        return Ok(());
    }
    let now = validation::now();
    for (key, scope, description) in PERMISSIONS {
        tx.execute(
            "INSERT INTO permissions VALUES (?1,?2,?3)",
            params![key, scope, description],
        )?;
    }
    for (role, key, name) in [
        (ADMIN_ROLE, "initial_administrator", "Initial Administrator"),
        ("00000000-0000-4000-8000-000000000002", "finance", "Finance"),
        ("00000000-0000-4000-8000-000000000003", "viewer", "Viewer"),
    ] {
        tx.execute("INSERT INTO roles (id,role_key,display_name,system_role,created_at,updated_at) VALUES (?1,?2,?3,1,?4,?4)",params![role,key,name,now])?;
        let keys: Vec<&str> = match key {
            "initial_administrator" => PERMISSIONS.iter().map(|x| x.0).collect(),
            "finance" => vec![
                "clients.view",
                "billing.view",
                "billing.manage",
                "pricing.view",
            ],
            _ => vec![
                "clients.view",
                "billing.view",
                "pricing.view",
                "tasks.view",
                "analytics.view",
            ],
        };
        for permission in keys {
            tx.execute("INSERT INTO role_permissions(id,role_id,permission_key,seeded,assigned_at) VALUES (?1,?2,?3,1,?4)",params![validation::new_id(),role,permission,now])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub const PERMISSIONS: &[(&str, &str, &str)] = &[
    ("users.view", "global", "View user identities"),
    (
        "users.manage",
        "global",
        "Create and maintain user identities",
    ),
    (
        "roles.view",
        "global",
        "View roles and permission assignments",
    ),
    (
        "roles.manage",
        "global",
        "Maintain roles and permission assignments",
    ),
    ("audit.view", "global", "View immutable audit history"),
    ("clients.create", "global", "Create client records"),
    ("clients.view", "client", "View client records"),
    ("clients.update", "client", "Update client records"),
    ("clients.archive", "client", "Archive client records"),
    ("activity.view", "client", "View client activity"),
    ("billing.view", "client", "View client billing records"),
    ("billing.manage", "client", "Manage client billing records"),
    ("billing.create", "client", "Create client collections"),
    (
        "billing.update",
        "client",
        "Update client collections and record payments",
    ),
    ("billing.delete", "client", "Cancel client collections"),
    ("pricing.view", "client", "View client pricing"),
    ("pricing.manage", "client", "Manage client pricing"),
    ("tasks.view", "client", "View client tasks"),
    ("tasks.manage", "client", "Manage client tasks"),
    ("tasks.create", "client", "Create client tasks"),
    ("tasks.update", "client", "Update client tasks"),
    ("tasks.delete", "client", "Archive client tasks"),
    (
        "planning.view",
        "client",
        "View client plans and milestones",
    ),
    (
        "planning.create",
        "client",
        "Create client plans and milestones",
    ),
    (
        "planning.update",
        "client",
        "Update client plans and milestones",
    ),
    (
        "planning.archive",
        "client",
        "Archive client plans and milestones",
    ),
    ("reminders.view", "client", "View client reminders"),
    ("reminders.create", "client", "Create client reminders"),
    ("reminders.update", "client", "Update client reminders"),
    ("analytics.view", "client", "View client analytics"),
    (
        "integrations.manage",
        "client",
        "Manage client integrations",
    ),
    (
        "integrations.view",
        "client",
        "View client integration metadata",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_are_repeatable_and_enforce_history_constraints() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("else.sqlite3");
        let database = Database::open(&path, true).unwrap();
        database.ready().await.unwrap();
        assert!(Database::open(&path, true).is_ok());
        let connection = connection(&path).unwrap();
        assert_eq!(
            connection
                .query_row::<String, _, _>("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap(),
            "wal"
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>("PRAGMA foreign_keys", [], |r| r.get(0))
                .unwrap(),
            1
        );
        assert!(connection.execute("INSERT INTO sessions VALUES ('s','missing',zeroblob(32),zeroblob(32),'a','b',NULL)",[]).is_err());
        connection.execute("INSERT INTO audit_events VALUES ('a','2026',1,'system',NULL,'client.created','client','c',NULL,?1,'null','{}','{\"source\":\"cli\"}')",["A".repeat(26)]).unwrap();
        for after in [
            r#"{"password":"synthetic-private-value"}"#,
            r#"{"exists":true,"exists":false}"#,
            r#"{"task_status":"todo"}"#,
            r#"{"revision":1.5}"#,
        ] {
            assert!(connection.execute("INSERT INTO audit_events VALUES ('b','2026',1,'system',NULL,'client.created','client','c',NULL,?1,'null',?2,'{\"source\":\"cli\"}')",params!["A".repeat(26),after]).is_err());
        }
        assert!(connection.execute("DELETE FROM audit_events", []).is_err());
        assert!(
            connection
                .execute("UPDATE audit_events SET event_name='client.updated'", [])
                .is_err()
        );
    }

    #[test]
    fn legacy_data_never_becomes_a_silent_fresh_installation() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("18/docker")).unwrap();
        std::fs::write(directory.path().join("18/docker/PG_VERSION"), "18").unwrap();
        assert!(Database::open(&directory.path().join("else.sqlite3"), true).is_err());
        assert!(!directory.path().join("else.sqlite3").exists());
    }
}
