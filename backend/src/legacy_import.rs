//! Explicit, conservative PostgreSQL v28 import from a private offline export.
//! No PostgreSQL client is linked into the application. The source is retained.
use crate::{
    audit::{self, Event, Snapshot},
    credentials::Keyring,
    db,
    error::{Error, Result},
    private_files as files, recovery, security, validation,
};
use rusqlite::{Transaction, TransactionBehavior, params, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
const MAX_LINE: usize = 2_621_440;
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Column {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    nullable: bool,
}
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Table {
    table: String,
    columns: Vec<Column>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: u8,
    source: String,
    version: u32,
    exported_at: String,
    source_sha256: String,
    keyring_sha256: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Line {
    Header {
        format: u8,
        source: String,
        version: u32,
        schema: Vec<Table>,
        counts: BTreeMap<String, i64>,
    },
    Row {
        table: String,
        row: BTreeMap<String, Value>,
    },
    Complete {
        counts: BTreeMap<String, i64>,
    },
}
#[derive(Serialize)]
pub struct Imported {
    pub source_rows: BTreeMap<String, i64>,
    pub imported_rows: BTreeMap<String, i64>,
    pub removed_version_checker_rows: BTreeMap<String, i64>,
}
struct Pending(PathBuf);
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub fn import(bundle: &Path, database: &Path, key_file: &Path) -> Result<Imported> {
    files::directory(bundle, false)?;
    files::path(database)?;
    files::path(key_file)?;
    let parent = database.parent().ok_or(Error::Internal)?;
    files::directory(parent, true)?;
    if db::legacy_present(parent) {
        return Err(Error::Conflict("import_requires_empty_storage"));
    }
    let _lease = files::RuntimeLease::acquire(database)?;
    for path in [
        database.to_path_buf(),
        key_file.to_path_buf(),
        parent.join(".control/restore-pending.json"),
        PathBuf::from(format!("{}-wal", database.display())),
        PathBuf::from(format!("{}-shm", database.display())),
    ] {
        if path.symlink_metadata().is_ok() {
            return Err(Error::Conflict("import_requires_empty_storage"));
        }
    }
    let marker = parent.join(".control/restore-pending.json");
    files::write(
        &marker,
        b"{\"operation\":\"import\",\"state\":\"pending\"}",
        0o600,
    )?;
    files::sync_directory(marker.parent().ok_or(Error::Internal)?)?;
    files::sync_directory(parent)?;
    let manifest: Manifest =
        validation::json(&files::read(&bundle.join("manifest.json"), 16_384)?)?;
    if manifest.format != 1
        || manifest.source != "postgresql"
        || manifest.version != 28
        || validation::instant(&manifest.exported_at).is_err()
    {
        return Err(Error::Invalid("unsupported_import"));
    }
    let raw_keys = files::read(&bundle.join("keyring.json"), 8192)?;
    if format!("{:x}", Sha256::digest(&raw_keys)) != manifest.keyring_sha256 {
        return Err(Error::Invalid("invalid_import"));
    }
    let ring = Keyring::parse(&raw_keys)?;
    let source = bundle.join("postgres.jsonl");
    if recovery::hash_file(&source)? != manifest.source_sha256 {
        return Err(Error::Invalid("invalid_import"));
    }
    let pending = Pending(parent.join(format!(".import-{}", validation::new_id())));
    files::directory(&pending.0, true)?;
    let staged = pending.0.join("else.sqlite3");
    drop(db::Database::open(&staged, false)?);
    let mut destination = db::connection(&staged)?;
    destination.query_row("SELECT begin_transaction_token()", [], |r| {
        r.get::<_, String>(0)
    })?;
    let tx = destination.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("DELETE FROM billing_currencies; CREATE TEMP TABLE imported_balances (id TEXT PRIMARY KEY,paid_minor INTEGER NOT NULL) STRICT;")?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(&source)
        .map_err(|_| Error::Internal)?;
    let mut reader = BufReader::new(file);
    let Line::Header {
        format: 1,
        source: header_source,
        version: 28,
        schema,
        counts,
    } = next(&mut reader)?.ok_or(Error::Invalid("invalid_import"))?
    else {
        return Err(Error::Invalid("unsupported_import"));
    };
    let expected: Vec<Table> =
        serde_json::from_str(include_str!("../migrations/postgres-source-schema.json"))
            .map_err(|_| Error::Internal)?;
    if header_source != "postgresql" || schema != expected {
        return Err(Error::Invalid("unsupported_import"));
    }
    let names = recovery::TABLES
        .iter()
        .copied()
        .filter(|n| *n != "import_receipts")
        .collect::<Vec<_>>();
    if counts.len() != names.len()
        || names
            .iter()
            .any(|n| counts.get(*n).is_none_or(|v| !(0..=5_000_000).contains(v)))
    {
        return Err(Error::Invalid("invalid_import"));
    }
    let mut seen: BTreeMap<String, i64> = names.iter().map(|n| ((*n).into(), 0)).collect();
    let mut removed: BTreeMap<String, i64> = BTreeMap::new();
    let mut index = 0;
    loop {
        match next(&mut reader)?.ok_or(Error::Invalid("incomplete_import"))? {
            Line::Row { table, row } => {
                let position = names
                    .iter()
                    .position(|n| *n == table)
                    .ok_or(Error::Invalid("invalid_import"))?;
                if position < index {
                    return Err(Error::Invalid("invalid_import"));
                }
                index = position;
                let count = seen
                    .get_mut(&table)
                    .ok_or(Error::Invalid("invalid_import"))?;
                *count += 1;
                if *count > *counts.get(&table).ok_or(Error::Invalid("invalid_import"))? {
                    return Err(Error::Invalid("invalid_import"));
                }
                let definition = schema
                    .iter()
                    .find(|s| s.table == table)
                    .ok_or(Error::Internal)?;
                if row.len() != definition.columns.len()
                    || definition
                        .columns
                        .iter()
                        .any(|c| !row.contains_key(&c.name))
                {
                    return Err(Error::Invalid("invalid_import"));
                }
                let values = definition
                    .columns
                    .iter()
                    .map(|c| convert(c, &row[&c.name]))
                    .collect::<Result<Vec<_>>>()?;
                if matches!(table.as_str(), "permissions" | "role_permissions")
                    && row
                        .get("permission_key")
                        .and_then(Value::as_str)
                        .is_some_and(|v| matches!(v, "releases.view" | "releases.manage"))
                {
                    *removed.entry(table).or_default() += 1;
                    continue;
                }
                insert(&tx, definition, values, &row)?;
            }
            Line::Complete { counts: footer } => {
                if counts != footer || counts != seen || next(&mut reader)?.is_some() {
                    return Err(Error::Invalid("incomplete_import"));
                }
                break;
            }
            _ => return Err(Error::Invalid("invalid_import")),
        }
    }
    let balances:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM imported_balances b JOIN collections c ON c.id=b.id WHERE b.paid_minor<>c.paid_minor)",[],|r|r.get(0))?;
    if balances {
        return Err(Error::Invalid("import_ledger_mismatch"));
    }
    db::validate_history(&tx, false)?;
    crate::pricing::verify_lines(&tx)?;
    // The source catalog is an authorization boundary, not extensible imported data.
    let mut permission_query =
        tx.prepare("SELECT permission_key,scope_kind FROM permissions ORDER BY permission_key")?;
    let actual_catalog = permission_query
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut expected_catalog = db::PERMISSIONS
        .iter()
        .map(|p| (p.0.to_owned(), p.1.to_owned()))
        .collect::<Vec<_>>();
    expected_catalog.sort();
    if actual_catalog != expected_catalog {
        return Err(Error::Invalid("unsupported_import"));
    }
    drop(permission_query);
    if seen["users"] > 0 {
        security::preserve_administrator(&tx)?;
    }
    let mut imported = BTreeMap::new();
    for name in &names {
        let actual: i64 =
            tx.query_row(&format!("SELECT count(*) FROM {name}"), [], |r| r.get(0))?;
        if actual != seen[*name] - removed.get(*name).copied().unwrap_or(0) {
            return Err(Error::Invalid("import_row_count_mismatch"));
        }
        imported.insert((*name).into(), actual);
    }
    let summary = Imported {
        source_rows: seen,
        imported_rows: imported,
        removed_version_checker_rows: removed,
    };
    tx.execute(
        "INSERT INTO import_receipts VALUES ('postgresql',?1,?2,?3)",
        params![
            validation::now(),
            manifest.source_sha256,
            serde_json::to_string(&summary).map_err(|_| Error::Internal)?
        ],
    )?;
    audit::append(
        &tx,
        Event {
            actor: None,
            request_id: &audit::request_id(),
            kind: "data_import",
            id: &validation::new_id(),
            client: None,
            action: "created",
            before: Some(Snapshot {
                exists: Some(false),
                ..Default::default()
            }),
            after: Some(Snapshot {
                exists: Some(true),
                ..Default::default()
            }),
            source: "cli",
        },
    )?;
    tx.commit()?;
    let _counts = recovery::verify(&mut destination, &ring)?;
    let fresh = Keyring::fresh_restore_document(&raw_keys, &destination)?;
    destination.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
    destination.pragma_update(None, "journal_mode", "DELETE")?;
    drop(destination);
    if recovery::hash_file(&source)? != manifest.source_sha256
        || *files::read(&bundle.join("keyring.json"), 8192)? != *raw_keys
    {
        return Err(Error::Invalid("import_source_changed"));
    }
    let key_parent = key_file.parent().ok_or(Error::Internal)?;
    files::directory(key_parent, true)?;
    let staged_key = key_parent.join(format!(".import-key-{}", validation::new_id()));
    files::write(&staged_key, &fresh, 0o400)?;
    files::publish(&staged_key, key_file)?;
    files::publish(&staged, database)?;
    fs::remove_file(&marker).map_err(|_| Error::Internal)?;
    files::sync_directory(marker.parent().ok_or(Error::Internal)?)?;
    tracing::info!("legacy_database_import_verified");
    Ok(summary)
}
fn next(reader: &mut BufReader<fs::File>) -> Result<Option<Line>> {
    let mut raw = Vec::new();
    let n = Read::take(&mut *reader, (MAX_LINE + 1) as u64)
        .read_until(b'\n', &mut raw)
        .map_err(|_| Error::Internal)?;
    if n == 0 {
        return Ok(None);
    }
    if n > MAX_LINE || raw.last() != Some(&b'\n') {
        return Err(Error::Invalid("invalid_import"));
    }
    let value = crate::provider_json::parse(&raw).map_err(|_| Error::Invalid("invalid_import"))?;
    serde_json::from_value(value)
        .map(Some)
        .map_err(|_| Error::Invalid("invalid_import"))
}
fn convert(column: &Column, value: &Value) -> Result<SqlValue> {
    if column.kind == "jsonb" && value.is_null() {
        return Ok(SqlValue::Text("null".into()));
    }
    if value.is_null() {
        return if column.nullable {
            Ok(SqlValue::Null)
        } else {
            Err(Error::Invalid("invalid_import"))
        };
    }
    match column.kind.as_str() {
        "int2" | "int4" | "int8" => value
            .as_i64()
            .map(SqlValue::Integer)
            .ok_or(Error::Invalid("invalid_import")),
        "bool" => value
            .as_bool()
            .map(|v| SqlValue::Integer(i64::from(v)))
            .ok_or(Error::Invalid("invalid_import")),
        "jsonb" => Ok(SqlValue::Text(
            serde_json::to_string(value).map_err(|_| Error::Internal)?,
        )),
        "text" | "uuid" | "date" | "timestamptz" | "xid8" => {
            let raw = value
                .as_str()
                .filter(|s| s.len() <= 32768)
                .ok_or(Error::Invalid("invalid_import"))?;
            match column.kind.as_str() {
                "uuid" => {
                    validation::id(raw).map_err(|_| Error::Invalid("invalid_import"))?;
                }
                "date" => {
                    validation::date(raw).map_err(|_| Error::Invalid("invalid_import"))?;
                }
                "timestamptz" => {
                    if validation::instant(raw).map_err(|_| Error::Invalid("invalid_import"))?
                        != raw
                    {
                        return Err(Error::Invalid("invalid_import"));
                    }
                }
                "xid8"
                    if raw.is_empty()
                        || raw.len() > 20
                        || !raw.bytes().all(|b| b.is_ascii_digit()) =>
                {
                    return Err(Error::Invalid("invalid_import"));
                }
                _ => (),
            }
            Ok(SqlValue::Text(raw.into()))
        }
        "bytea" => {
            let raw = value
                .as_str()
                .filter(|s| {
                    s.len() <= 32956
                        && s.len() % 2 == 0
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or(Error::Invalid("invalid_import"))?;
            Ok(SqlValue::Blob(
                (0..raw.len())
                    .step_by(2)
                    .map(|i| {
                        u8::from_str_radix(&raw[i..i + 2], 16)
                            .map_err(|_| Error::Invalid("invalid_import"))
                    })
                    .collect::<Result<_>>()?,
            ))
        }
        _ => Err(Error::Invalid("unsupported_import")),
    }
}
fn insert(
    tx: &Transaction<'_>,
    table: &Table,
    values: Vec<SqlValue>,
    row: &BTreeMap<String, Value>,
) -> Result<()> {
    let mut columns = Vec::new();
    let mut fields = Vec::new();
    for (column, mut value) in table.columns.iter().zip(values) {
        if column.name == "creation_xid" {
            continue;
        }
        if table.table == "collections" && column.name == "paid_minor" {
            tx.execute(
                "INSERT INTO imported_balances VALUES (?1,?2)",
                params![
                    row["id"].as_str().ok_or(Error::Invalid("invalid_import"))?,
                    value
                ],
            )?;
            value = SqlValue::Integer(0);
        }
        columns.push(column.name.clone());
        fields.push(value);
    }
    if table.table == "analytics_snapshots" {
        let value = fields
            .get(
                columns
                    .iter()
                    .position(|c| c == "workspace")
                    .ok_or(Error::Internal)?,
            )
            .ok_or(Error::Internal)?;
        let SqlValue::Text(raw) = value else {
            return Err(Error::Internal);
        };
        let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
        columns.push("workspace_sha256".into());
        fields.push(SqlValue::Text(digest));
    }
    let placeholders = (1..=fields.len())
        .map(|n| format!("?{n}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({placeholders})",
        table.table,
        columns.join(",")
    );
    tx.prepare_cached(&sql)?
        .execute(rusqlite::params_from_iter(fields))?;
    Ok(())
}
