//! A bounded projection of already-validated stored observations. Never calls a provider.
use super::registry::Arguments;
use crate::{
    error::{Error, Result},
    security::Actor,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
pub fn project(actor: &Actor, args: &Arguments, mut document: Value) -> Result<Value> {
    let query = args.0.get("query").cloned().unwrap_or(json!({}));
    let query = query
        .as_object()
        .ok_or(Error::Invalid("invalid_arguments"))?;
    let section = query
        .get("section")
        .and_then(Value::as_str)
        .unwrap_or("summary");
    let provider = args.0["provider"]
        .as_str()
        .ok_or(Error::Invalid("invalid_arguments"))?;
    let supported = match provider {
        "ga4" => &["summary", "daily", "acquisition", "devices", "landing"][..],
        "meta_ads" => &["summary", "daily"][..],
        "woocommerce" => &["summary", "orders", "refunds", "products"][..],
        _ => return Err(Error::Invalid("invalid_arguments")),
    };
    if !supported.contains(&section) {
        return Err(Error::Invalid("invalid_arguments"));
    }
    if document["data"].is_null() {
        if query.contains_key("cursor") {
            return Err(Error::Conflict("report_changed"));
        }
        return Ok(document);
    }
    let limit = query
        .get("limit")
        .and_then(Value::as_str)
        .unwrap_or("25")
        .parse::<usize>()
        .map_err(|_| Error::Invalid("invalid_arguments"))?;
    if !(1..=50).contains(&limit) {
        return Err(Error::Invalid("invalid_arguments"));
    }
    let data = &document["data"];
    let (mut selected, rows_key) = match provider {
        "ga4" => {
            let mut selected = data[section].clone();
            if section == "summary" {
                selected["definitions"] = data["definitions"].clone()
            }
            (selected, Some("rows"))
        }
        "meta_ads" => {
            let mut selected = data["report"].clone();
            if section == "summary" {
                selected
                    .as_object_mut()
                    .ok_or(Error::Internal)?
                    .remove("days");
            }
            selected["collected_from"] = data["collected_from"].clone();
            selected["collected_through"] = data["collected_through"].clone();
            (
                selected,
                if section == "daily" {
                    Some("days")
                } else {
                    None
                },
            )
        }
        "woocommerce" => {
            if section == "summary" {
                let mut summary = data.clone();
                for (kind, field) in [
                    ("orders", "orders"),
                    ("refunds", "refunds"),
                    ("products", "products"),
                ] {
                    let object = summary[kind].as_object_mut().ok_or(Error::Internal)?;
                    let rows = object.remove(field).ok_or(Error::Internal)?;
                    object.insert(
                        "record_count".into(),
                        json!(rows.as_array().ok_or(Error::Internal)?.len().to_string()),
                    );
                }
                (summary, None)
            } else {
                (data[section].clone(), Some(section))
            }
        }
        _ => return Err(Error::Invalid("invalid_arguments")),
    };
    let binding = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                actor.delegation().ok_or(Error::Denied)?.grant_id.clone(),
                &args.0["client_id"],
                &args.0["id"],
                &args.0["from"],
                &args.0["to"],
                args.0.get("currency"),
                section,
                &document["status"]["synced_at"]
            ))
            .map_err(|_| Error::Internal)?
        )
    );
    let offset = if let Some(cursor) = query.get("cursor") {
        let raw = cursor
            .as_str()
            .filter(|v| v.len() <= 256)
            .ok_or(Error::Invalid("invalid_cursor"))?;
        let bytes = URL_SAFE_NO_PAD
            .decode(raw)
            .map_err(|_| Error::Invalid("invalid_cursor"))?;
        let (offset, old): (usize, String) =
            serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("invalid_cursor"))?;
        if old != binding {
            return Err(Error::Conflict("report_changed"));
        }
        offset
    } else {
        0
    };
    if let Some(key) = rows_key {
        let rows = selected[key].as_array_mut().ok_or(Error::Internal)?;
        let count = rows.len();
        if offset > count || (offset == count && offset != 0) {
            return Err(Error::Invalid("invalid_cursor"));
        }
        let end = offset
            .checked_add(limit)
            .ok_or(Error::Invalid("invalid_cursor"))?
            .min(count);
        let page = rows[offset..end].to_vec();
        *rows = page;
        let next = if end < count {
            Some(
                URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(&(end, &binding)).map_err(|_| Error::Internal)?),
            )
        } else {
            None
        };
        document["page"] =
            json!({"limit":limit,"record_count":count.to_string(),"next_cursor":next});
    } else if offset != 0 {
        return Err(Error::Invalid("invalid_cursor"));
    }
    document["section"] = json!(section);
    document["data"] = selected;
    Ok(document)
}
