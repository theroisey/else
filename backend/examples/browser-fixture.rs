//! Test-only local fixture access. This executable is never part of the image.
use roisey_else::{
    db::Database,
    error::{Error, Result},
    validation,
};
use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::{Batch, functions::FunctionFlags, types::ValueRef};
use std::{io::Read, path::PathBuf};

fn main() -> Result<()> {
    let root = PathBuf::from(std::env::var_os("AUTH_TEST_DIRECTORY").ok_or(Error::Internal)?);
    if !root.is_absolute()
        || !root
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with("else-browser-"))
        || std::fs::read(root.join(".fixture-control")).ok().as_deref()
            != Some(b"disposable-synthetic-browser-fixture")
    {
        return Err(Error::Invalid("fixture_directory_required"));
    }
    let mut raw = String::new();
    std::io::stdin()
        .take(1_048_577)
        .read_to_string(&mut raw)
        .map_err(|_| Error::Internal)?;
    if raw.len() > 1_048_576 {
        return Err(Error::Invalid("invalid_fixture"));
    }
    let db = Database::open(&root.join("else.sqlite3"), true)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|_| Error::Internal)?;
    let result = runtime.block_on(db.write(move |tx| {
        let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_INNOCUOUS;
        tx.create_scalar_function("new_id", 0, flags, |_| Ok(validation::new_id()))?;
        tx.create_scalar_function("utc_now", 0, flags, |_| Ok(validation::now()))?;
        tx.create_scalar_function("utc_shift", 1, flags, |c| {
            let seconds = c.get::<i64>(0)?;
            Ok((chrono::Utc::now() + chrono::Duration::seconds(seconds))
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true))
        })?;
        tx.create_scalar_function("sha256", 1, flags, |c| {
            use sha2::{Digest, Sha256};
            Ok(format!(
                "{:x}",
                Sha256::digest(c.get::<String>(0)?.as_bytes())
            ))
        })?;
        let mut batch = Batch::new(tx, &raw);
        let mut output = Vec::new();
        while let Some(mut statement) = batch.next()? {
            let count = statement.column_count();
            if count == 0 {
                statement.execute([])?;
                continue;
            }
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let mut fields = Vec::new();
                for n in 0..count {
                    fields.push(match row.get_ref(n)? {
                        ValueRef::Null => String::new(),
                        ValueRef::Integer(i) => i.to_string(),
                        ValueRef::Real(_) => return Err(Error::Invalid("approximate_fixture")),
                        ValueRef::Text(b) => std::str::from_utf8(b)
                            .map_err(|_| Error::Internal)?
                            .to_owned(),
                        ValueRef::Blob(b) => b.iter().map(|c| format!("{c:02x}")).collect(),
                    });
                }
                output.push(fields.join("|"));
            }
        }
        Ok(output.join("\n"))
    }))?;
    if !result.is_empty() {
        println!("{result}");
    }
    Ok(())
}
