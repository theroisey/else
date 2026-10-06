//! Stable keyset boundaries shared by history projections. The purpose binds a
//! cursor to its route and normalized filters; no event lookup is required.
use crate::{
    error::{Error, Result},
    validation,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Datelike, SecondsFormat, Utc};

pub struct Boundary {
    pub time: String,
    pub id: String,
}

pub fn limit(raw: Option<&str>) -> Result<usize> {
    let raw = raw.unwrap_or("25");
    if !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::Invalid("invalid_request"));
    }
    let limit = raw.parse().map_err(|_| Error::Invalid("invalid_request"))?;
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(limit)
}

pub fn utc(raw: &str) -> Result<String> {
    let Some(main) = raw.strip_suffix('Z') else {
        return Err(Error::Invalid("invalid_request"));
    };
    let (seconds, fraction) = main
        .split_once('.')
        .map_or((main, None), |(s, f)| (s, Some(f)));
    if seconds.len() != 19
        || seconds.as_bytes()[10] != b'T'
        || fraction
            .is_some_and(|f| f.is_empty() || f.len() > 6 || !f.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(Error::Invalid("invalid_request"));
    }
    let stamp = DateTime::parse_from_rfc3339(raw).map_err(|_| Error::Invalid("invalid_request"))?;
    if !(1..=9999).contains(&stamp.year()) || stamp.timestamp_subsec_nanos() >= 1_000_000_000 {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(stamp
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Micros, true))
}

pub fn canonical(raw: &str) -> Result<String> {
    let normalized = utc(raw)?;
    let main = normalized
        .trim_end_matches('Z')
        .trim_end_matches('0')
        .trim_end_matches('.');
    Ok(format!("{main}Z"))
}

pub fn encode(purpose: &str, time: &str, id: &str) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(format!("v1|{purpose}|{}|{id}", canonical(time)?)))
}

pub fn decode(purpose: &str, raw: Option<&str>) -> Result<Option<Boundary>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.len() > 256 {
        return Err(Error::Invalid("invalid_request"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| Error::Invalid("invalid_request"))?;
    if URL_SAFE_NO_PAD.encode(&bytes) != raw {
        return Err(Error::Invalid("invalid_request"));
    }
    let decoded = std::str::from_utf8(&bytes).map_err(|_| Error::Invalid("invalid_request"))?;
    let parts: Vec<_> = decoded.split('|').collect();
    if parts.len() != 4
        || parts[0] != "v1"
        || parts[1] != purpose
        || canonical(parts[2])? != parts[2]
    {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(Some(Boundary {
        time: utc(parts[2])?,
        id: validation::id(parts[3])?,
    }))
}

pub fn id_encode(purpose: &str, id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("v1|{purpose}|{id}"))
}
pub fn id_decode(purpose: &str, raw: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.len() > 128 {
        return Err(Error::Invalid("invalid_request"));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| Error::Invalid("invalid_request"))?;
    if URL_SAFE_NO_PAD.encode(&decoded) != raw {
        return Err(Error::Invalid("invalid_request"));
    }
    let decoded = std::str::from_utf8(&decoded).map_err(|_| Error::Invalid("invalid_request"))?;
    let parts: Vec<_> = decoded.split('|').collect();
    if parts.len() != 3 || parts[0] != "v1" || parts[1] != purpose {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(Some(validation::id(parts[2])?))
}
