//! Supported online backup and verified offline restore into empty storage.
//! Bundles retain keys; restoring always adds fresh active material.
use crate::{
    credentials::{Binding, Envelope, Keyring},
    db,
    error::{Error, Result},
    private_files as files,
    sync_period::Period,
    validation,
};
use rusqlite::{
    Connection,
    backup::{Backup, StepResult},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub(crate) const TABLES: &[&str] = &[
    "users",
    "sessions",
    "permissions",
    "roles",
    "role_permissions",
    "client_scopes",
    "user_roles",
    "audit_events",
    "clients",
    "client_contacts",
    "client_tags",
    "tasks",
    "task_tags",
    "plans",
    "milestones",
    "milestone_task_links",
    "reminders",
    "billing_currencies",
    "collections",
    "payments",
    "pricing_sheets",
    "pricing_versions",
    "pricing_lines",
    "pricing_snapshots",
    "pricing_snapshot_lines",
    "integration_connections",
    "integration_encryption_keys",
    "integration_credentials",
    "analytics_sync_jobs",
    "analytics_snapshots",
    "client_websites",
    "website_integrations",
    "user_locale_preferences",
    "import_receipts",
];
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: u8,
    schema: u8,
    created_at: String,
    database_sha256: String,
    keyring_sha256: String,
    row_counts: BTreeMap<String, i64>,
}
struct Pending(PathBuf);
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn backup(database: &Path, key_file: &Path, destination: &Path) -> Result<()> {
    if database.symlink_metadata().is_err() {
        return Err(Error::NotFound);
    }
    files::path(database)?;
    files::path(key_file)?;
    files::path(destination)?;
    let parent = destination.parent().ok_or(Error::Internal)?;
    files::directory(parent, true)?;
    if destination.symlink_metadata().is_ok() {
        return Err(Error::Conflict("destination_exists_or_unavailable"));
    }
    let pending = Pending(parent.join(format!(".backup-{}", validation::new_id())));
    files::directory(&pending.0, true)?;
    let raw = files::read(key_file, 8192)?;
    let ring = Keyring::parse(&raw)?;
    let source = db::connection(database)?;
    ring.preflight(&source, false, false)?;
    let artifact = pending.0.join("database.sqlite3");
    let mut target = db::connection(&artifact)?;
    {
        let work = Backup::new(&source, &mut target)?;
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            match work.step(256)? {
                StepResult::Done => break,
                StepResult::More | StepResult::Busy | StepResult::Locked => {
                    if Instant::now() >= deadline {
                        return Err(Error::Busy);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                _ => return Err(Error::Internal),
            }
        }
    }
    // Produce one self-contained file rather than copying a live WAL database.
    target.pragma_update(None, "journal_mode", "DELETE")?;
    let counts = verify(&mut target, &ring)?;
    drop(target);
    files::write(&pending.0.join("keyring.json"), &raw, 0o400)?;
    let manifest = Manifest {
        format: 1,
        schema: 1,
        created_at: validation::now(),
        database_sha256: hash_file(&artifact)?,
        keyring_sha256: format!("{:x}", Sha256::digest(&raw)),
        row_counts: counts,
    };
    files::write(
        &pending.0.join("manifest.json"),
        &serde_json::to_vec(&manifest).map_err(|_| Error::Internal)?,
        0o600,
    )?;
    files::sync_directory(&pending.0)?;
    files::publish(&pending.0, destination)?;
    tracing::info!("database_backup_verified");
    Ok(())
}

pub fn restore(bundle: &Path, database: &Path, key_file: &Path) -> Result<()> {
    files::path(bundle)?;
    files::path(database)?;
    files::path(key_file)?;
    let parent = database.parent().ok_or(Error::Internal)?;
    files::directory(parent, true)?;
    if db::legacy_present(parent) {
        return Err(Error::Conflict("restore_requires_empty_storage"));
    }
    let _lease = files::RuntimeLease::acquire(database)?;
    let marker = parent.join(".control/restore-pending.json");
    if marker.symlink_metadata().is_ok() {
        return Err(Error::Conflict("restore_incomplete"));
    }
    // Switch to a new volume. Retain the previous volume for rollback.
    for path in [
        database.to_path_buf(),
        PathBuf::from(format!("{}-wal", database.display())),
        PathBuf::from(format!("{}-shm", database.display())),
        key_file.to_path_buf(),
    ] {
        if path.symlink_metadata().is_ok() {
            return Err(Error::Conflict("restore_requires_empty_storage"));
        }
    }
    // Fence fresh startup before expensive verification or staged copying.
    // A rejected/interrupted operation leaves this durable marker in place;
    // preserve that target and choose another explicitly empty volume.
    files::write(&marker, b"{\"state\":\"pending\"}", 0o600)?;
    files::sync_directory(marker.parent().ok_or(Error::Internal)?)?;
    files::sync_directory(parent)?;
    let (manifest, raw, source_path) = verify_bundle(bundle)?;
    let mut source = db::readonly_connection(&source_path)?;
    let ring = Keyring::parse(&raw)?;
    let counts = verify(&mut source, &ring)?;
    if counts != manifest.row_counts {
        return Err(Error::Internal);
    }
    let fresh = Keyring::fresh_restore_document(&raw, &source)?;
    let pending = Pending(parent.join(format!(".restore-{}", validation::new_id())));
    files::directory(&pending.0, true)?;
    let restored = pending.0.join("database.sqlite3");
    let mut target = db::connection(&restored)?;
    {
        let backup = Backup::new(&source, &mut target)?;
        backup.run_to_completion(256, Duration::from_millis(5), None)?;
    }
    target.pragma_update(None, "journal_mode", "DELETE")?;
    if verify(&mut target, &Keyring::parse(&fresh)?)? != counts {
        return Err(Error::Internal);
    }
    drop(target);
    drop(source);
    let _ = verify_bundle(bundle)?;
    let key_parent = key_file.parent().ok_or(Error::Internal)?;
    files::directory(key_parent, true)?;
    let staged_key = key_parent.join(format!(".restore-key-{}", validation::new_id()));
    files::write(&staged_key, &fresh, 0o400)?;
    if let Err(error) = files::publish(&staged_key, key_file) {
        let _ = fs::remove_file(staged_key);
        return Err(error);
    }
    // Keep the installed key on failure: interrupted restore cannot provision
    // unrelated material. Reconcile explicitly before retrying.
    files::publish(&restored, database)?;
    fs::remove_file(&marker).map_err(|_| Error::Internal)?;
    files::sync_directory(marker.parent().ok_or(Error::Internal)?)?;
    tracing::info!("database_restore_verified_with_fresh_key");
    Ok(())
}

fn verify_bundle(bundle: &Path) -> Result<(Manifest, zeroize::Zeroizing<Vec<u8>>, PathBuf)> {
    files::directory(bundle, false)?;
    let raw = files::read(&bundle.join("manifest.json"), 16_384)?;
    let manifest: Manifest = validation::json(&raw)?;
    if manifest.format != 1
        || manifest.schema != 1
        || validation::instant(&manifest.created_at).is_err()
    {
        return Err(Error::Internal);
    }
    let key = files::read(&bundle.join("keyring.json"), 8192)?;
    Keyring::parse(&key)?;
    let database = bundle.join("database.sqlite3");
    if hash_file(&database)? != manifest.database_sha256
        || format!("{:x}", Sha256::digest(&key)) != manifest.keyring_sha256
    {
        return Err(Error::Internal);
    }
    for extension in ["-wal", "-shm", "-journal"] {
        if PathBuf::from(format!("{}{extension}", database.display()))
            .symlink_metadata()
            .is_ok()
        {
            return Err(Error::Internal);
        }
    }
    Ok((manifest, key, database))
}

pub(crate) fn hash_file(path: &Path) -> Result<String> {
    files::path(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| Error::Internal)?;
    let before = file.metadata().map_err(|_| Error::Internal)?;
    if !before.is_file()
        || before.nlink() != 1
        || before.mode() & 0o077 != 0
        || before.len() > 8 * 1024 * 1024 * 1024
    {
        return Err(Error::Internal);
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65_536];
    loop {
        let n = file.read(&mut buffer).map_err(|_| Error::Internal)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    let after = file.metadata().map_err(|_| Error::Internal)?;
    if (
        before.dev(),
        before.ino(),
        before.len(),
        before.mode(),
        before.uid(),
        before.nlink(),
        before.mtime(),
        before.mtime_nsec(),
        before.ctime(),
        before.ctime_nsec(),
    ) != (
        after.dev(),
        after.ino(),
        after.len(),
        after.mode(),
        after.uid(),
        after.nlink(),
        after.mtime(),
        after.mtime_nsec(),
        after.ctime(),
        after.ctime_nsec(),
    ) {
        return Err(Error::Internal);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(crate) fn verify(connection: &mut Connection, ring: &Keyring) -> Result<BTreeMap<String, i64>> {
    let tx = connection.transaction()?;
    let integrity: String = tx.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok"
        || tx
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
    {
        return Err(Error::Internal);
    }
    let versions: Vec<(i64, String)> = tx
        .prepare("SELECT version,sha256 FROM schema_migrations ORDER BY version")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    if versions != vec![(1, format!("{:x}", Sha256::digest(db::SCHEMA)))] {
        return Err(Error::Internal);
    }
    db::validate_history(&tx, false)?;
    crate::pricing::verify_lines(&tx)?;
    let invalid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM collections c WHERE c.paid_minor<>coalesce((SELECT sum(amount_minor) FROM payments p WHERE p.collection_id=c.id),0) OR c.revision<coalesce((SELECT max(collection_revision) FROM payments p WHERE p.collection_id=c.id),1))",[],|r|r.get(0))?;
    if invalid {
        return Err(Error::Internal);
    }
    ring.preflight(&tx, false, false)?;
    let mut credentials=tx.prepare("SELECT c.client_id,c.id,c.provider,s.purpose,s.envelope,s.generation,c.generation,k.key_label,k.reservations FROM integration_connections c JOIN integration_credentials s ON s.connection_id=c.id JOIN integration_encryption_keys k ON k.id=s.key_id")?;
    let mut rows = credentials.query([])?;
    while let Some(row) = rows.next()? {
        let (client, connection, provider, purpose, raw, label): (
            String,
            String,
            String,
            String,
            Vec<u8>,
            String,
        ) = (
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(7)?,
        );
        if row.get::<_, i64>(5)? > row.get::<_, i64>(6)?
            || row.get::<_, i64>(8)? < 1
            || raw.get(1).copied().map(usize::from) != Some(label.len())
            || raw.get(2..2 + label.len()) != Some(label.as_bytes())
        {
            return Err(Error::Internal);
        }
        let binding = Binding {
            client: &client,
            connection: &connection,
            provider: &provider,
            purpose: &purpose,
        };
        let _plaintext = ring.open(&binding, &Envelope::parse(raw)?)?;
    }
    drop(rows);
    drop(credentials);
    let mut snapshots=tx.prepare("SELECT client_id,connection_id,provider,since,until,start_at,end_at,currency,workspace,workspace_sha256 FROM analytics_snapshots")?;
    let mut rows = snapshots.query([])?;
    while let Some(row) = rows.next()? {
        let period = Period::stored(
            row.get(2)?,
            [
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ],
        )?;
        let raw: String = row.get(8)?;
        if format!("{:x}", Sha256::digest(raw.as_bytes())) != row.get::<_, String>(9)? {
            return Err(Error::Internal);
        }
        crate::providers::workspace::Workspace::decode(
            raw.as_bytes(),
            &row.get::<_, String>(0)?,
            &row.get::<_, String>(1)?,
            &period,
        )?;
    }
    drop(rows);
    drop(snapshots);
    let mut counts = BTreeMap::new();
    for table in TABLES {
        counts.insert(
            (*table).into(),
            tx.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?,
        );
    }
    tx.commit()?;
    Ok(counts)
}
