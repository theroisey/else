//! Private evidence is transactional durable data, never a public static asset.
use super::*;
use crate::{
    audit::{self, Snapshot},
    db::Database,
    query::row_json,
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
pub const MAX_FILE: usize = 8 * 1024 * 1024;
pub fn media(bytes: &[u8], declared: &str) -> Result<&'static str> {
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes.len() >= 24
        && &bytes[12..16] == b"IHDR"
    {
        "image/png"
    } else if bytes.len() >= 4
        && bytes.starts_with(&[0xff, 0xd8, 0xff])
        && bytes.ends_with(&[0xff, 0xd9])
    {
        "image/jpeg"
    } else if bytes.len() >= 20
        && &bytes[..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
        && [b"VP8 ", b"VP8L", b"VP8X"]
            .iter()
            .any(|v| v.as_slice() == &bytes[12..16])
        && u32::from_le_bytes(
            bytes[4..8]
                .try_into()
                .map_err(|_| Error::Invalid("invalid_request"))?,
        ) as usize
            == bytes.len() - 8
    {
        "image/webp"
    } else if bytes.len() >= 12
        && bytes.starts_with(b"%PDF-")
        && bytes.windows(5).rev().take(1024).any(|v| v == b"%%EOF")
    {
        "application/pdf"
    } else {
        return Err(Error::Invalid("unsupported_evidence"));
    };
    if declared != mime || bytes.len() > MAX_FILE {
        return Err(Error::Invalid("unsupported_evidence"));
    }
    Ok(mime)
}
fn name(raw: &str) -> Result<String> {
    let raw = validation::text(raw, 120, true, false)?;
    if raw.contains(['/', '\\']) || raw == "." || raw == ".." {
        return Err(Error::Invalid("invalid_request"));
    }
    let name: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(name)
}
pub struct Upload {
    pub id: String,
    pub filename: String,
    pub declared: String,
    pub body: Vec<u8>,
}
pub async fn upload(
    db: &Database,
    actor: Actor,
    client: String,
    input: Upload,
    admission: Option<tokio::sync::OwnedSemaphorePermit>,
) -> Result<Value> {
    let Upload {
        id,
        filename,
        declared,
        body,
    } = input;
    validation::id(&id)?;
    let filename = name(&filename)?;
    let mime = media(&body, &declared)?.to_owned();
    let digest = format!("{:x}", Sha256::digest(&body));
    db.write(move|tx|{
        let _admission=admission;
        security::fresh(tx,&actor)?;
        security::require(tx,&actor,"clients.view",Some(&client)).map_err(hidden)?;
        security::require_any(tx,&actor,&["tickets.create","tickets.deliver"],&client).map_err(hidden)?;
        if let Some(old)=tx.query_row("SELECT id,client_id,uploaded_by,filename,mime,sha256 FROM request_evidence WHERE id=?1",[&id],row_json).optional()? {
            if old["client_id"]!=client || old["uploaded_by"]!=actor.user_id || old["filename"]!=filename || old["mime"]!=mime || old["sha256"]!=digest {return Err(Error::Conflict("command_conflict"))}
            return Ok(json!({"id":id,"replayed":true}));
        }
        security::client(tx,&client,true)?;
        let cutoff=(chrono::Utc::now()-chrono::Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Micros,true);
        tx.execute("DELETE FROM request_evidence WHERE request_id IS NULL AND uploaded_by=?1 AND created_at<?2",params![actor.user_id,cutoff])?;
        let total:i64=tx.query_row("SELECT coalesce(sum(size),0) FROM request_evidence",[],|r|r.get(0))?;
        let staged:i64=tx.query_row("SELECT count(*) FROM request_evidence WHERE uploaded_by=?1 AND request_id IS NULL",[&actor.user_id],|r|r.get(0))?;
        if total+body.len() as i64>2*1024*1024*1024 || staged>=32 {return Err(Error::Conflict("evidence_quota"))}
        tx.execute("INSERT INTO request_evidence(id,client_id,uploaded_by,filename,mime,size,sha256,content,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,client,actor.user_id,filename,mime,body.len() as i64,digest,body,validation::now()])?;
        Ok(json!({"id":id,"replayed":false}))
    }).await
}
pub(crate) fn bind(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    request: &str,
    delivery: Option<&str>,
    ids: &[String],
) -> Result<()> {
    let (count, total): (i64, i64) = tx.query_row(
        "SELECT count(*),coalesce(sum(size),0) FROM request_evidence WHERE request_id=?1",
        [request],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if ids.len() > 8 || count + ids.len() as i64 > 32 {
        return Err(Error::Invalid("evidence_quota"));
    }
    let mut size = total;
    let mut distinct = std::collections::BTreeSet::new();
    for id in ids {
        validation::id(id)?;
        if !distinct.insert(id) {
            return Err(Error::Invalid("invalid_request"));
        }
        let bytes:i64=tx.query_row("SELECT size FROM request_evidence WHERE id=?1 AND client_id=?2 AND uploaded_by=?3 AND request_id IS NULL",params![id,client,actor.user_id],|r|r.get(0))?;
        size += bytes;
        if size > 64 * 1024 * 1024 {
            return Err(Error::Invalid("evidence_quota"));
        }
        tx.execute(
            "UPDATE request_evidence SET request_id=?1,delivery_id=?2 WHERE id=?3",
            params![request, delivery, id],
        )?;
        audit::mutation(
            tx,
            actor,
            "request_evidence",
            id,
            Some(client),
            "created",
            (None, Snapshot::revision(1)),
        )?;
    }
    Ok(())
}
pub struct File {
    pub body: Vec<u8>,
    pub mime: String,
    pub filename: String,
}
pub async fn read(db: &Database, actor: Actor, client: String, id: String) -> Result<File> {
    db.read(move |tx| {
        security::fresh(tx, &actor)?;
        let (request, owner): (Option<String>, String) = tx.query_row(
            "SELECT request_id,uploaded_by FROM request_evidence WHERE id=?1 AND client_id=?2",
            params![id, client],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if let Some(request) = request {
            requests::visible(tx, &actor, &client, &request)?;
        } else {
            security::require(tx, &actor, "clients.view", Some(&client)).map_err(hidden)?;
            security::require_any(tx, &actor, &["tickets.create", "tickets.deliver"], &client)
                .map_err(hidden)?;
            if owner != actor.user_id {
                return Err(Error::NotFound);
            }
        }
        Ok(tx.query_row(
            "SELECT content,mime,filename FROM request_evidence WHERE id=?1",
            [id],
            |r| {
                Ok(File {
                    body: r.get(0)?,
                    mime: r.get(1)?,
                    filename: r.get(2)?,
                })
            },
        )?)
    })
    .await
}
pub(crate) fn verify(tx: &Transaction<'_>) -> Result<()> {
    let mut statement = tx.prepare("SELECT mime,content,sha256 FROM request_evidence")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let mime: String = row.get(0)?;
        let data: Vec<u8> = row.get(1)?;
        let digest: String = row.get(2)?;
        media(&data, &mime).map_err(|_| Error::Internal)?;
        if format!("{:x}", Sha256::digest(&data)) != digest {
            return Err(Error::Internal);
        }
    }
    Ok(())
}

/// Only the uploader can discard an unbound draft. Bound evidence is retained.
pub async fn discard(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.write(move |tx|{
        security::fresh(tx,&actor)?;
        security::require(tx,&actor,"clients.view",Some(&client)).map_err(hidden)?;
        security::require_any(tx,&actor,&["tickets.create","tickets.deliver"],&client).map_err(hidden)?;
        let bound:Option<bool>=tx.query_row("SELECT request_id IS NOT NULL FROM request_evidence WHERE id=?1 AND client_id=?2 AND uploaded_by=?3",params![id,client,actor.user_id],|r|r.get(0)).optional()?;
        if bound==Some(true){return Err(Error::Conflict("retained_evidence"))}
        tx.execute("DELETE FROM request_evidence WHERE id=?1 AND client_id=?2 AND uploaded_by=?3 AND request_id IS NULL",params![id,client,actor.user_id])?;
        Ok(json!({"discarded":true}))
    }).await
}
