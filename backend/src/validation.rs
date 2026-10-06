use crate::error::{Error, Result};
use chrono::{DateTime, Datelike, NaiveDate, SecondsFormat, Utc};
use serde::de::DeserializeOwned;
use uuid::Uuid;

pub fn id(value: &str) -> Result<String> {
    let parsed = Uuid::parse_str(value).map_err(|_| Error::Invalid("invalid_request"))?;
    if parsed.is_nil() || parsed.to_string() != value {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(value.to_owned())
}

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true)
}

pub fn instant(value: &str) -> Result<String> {
    // The durable timestamp transport retains at most microsecond precision.
    // Reject excess precision even when its final digits happen to be zero.
    if value.len() > 32
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(19) == Some(&b'.')
            && !(1..=6).contains(&value[20..].bytes().take_while(u8::is_ascii_digit).count())
    {
        return Err(Error::Invalid("invalid_dates"));
    }
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| Error::Invalid("invalid_dates"))?
        .with_timezone(&Utc);
    if !(1..=9999).contains(&parsed.year())
        || parsed.timestamp_subsec_nanos() >= 1_000_000_000
        || parsed.timestamp_subsec_nanos() % 1000 != 0
    {
        return Err(Error::Invalid("invalid_dates"));
    }
    Ok(parsed.to_rfc3339_opts(SecondsFormat::Micros, true))
}

pub fn date(value: &str) -> Result<String> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| Error::Invalid("invalid_request"))?;
    if !(1..=9999).contains(&parsed.year()) || parsed.format("%Y-%m-%d").to_string() != value {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(value.to_owned())
}

pub fn text(value: &str, max: usize, required: bool, multiline: bool) -> Result<String> {
    let value = value.replace("\r\n", "\n").trim().to_owned();
    if value.chars().count() > max
        || (required && value.is_empty())
        || value
            .chars()
            .any(|c| c.is_control() && !(multiline && c == '\n'))
    {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(value)
}

pub fn exact_integer(value: &str, positive: bool) -> Result<i64> {
    if value.is_empty()
        || !value.bytes().all(|c| c.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(Error::Invalid("invalid_request"));
    }
    let result = value
        .parse::<i64>()
        .map_err(|_| Error::Invalid("invalid_request"))?;
    if positive && result == 0 {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(result)
}

pub fn json<T: DeserializeOwned>(body: &[u8]) -> Result<T> {
    serde_json::from_slice(body).map_err(|_| Error::Invalid("invalid_request"))
}

pub fn email(value: &str) -> Result<String> {
    let result = text(value, 254, true, false)?.to_ascii_lowercase();
    let (local, domain) = result
        .split_once('@')
        .ok_or(Error::Invalid("invalid_request"))?;
    if result.len() < 3
        || !local
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&c))
        || !domain.contains('.')
        || domain.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                || label.starts_with('-')
                || label.ends_with('-')
        })
    {
        return Err(Error::Invalid("invalid_request"));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn financial_transport_never_accepts_approximate_values() {
        for value in ["01", "-1", "+1", " 1", "1.0", "1e2", "9223372036854775808"] {
            assert!(exact_integer(value, false).is_err(), "{value}");
        }
        assert_eq!(
            exact_integer("9223372036854775807", true).unwrap(),
            i64::MAX
        );
        assert!(exact_integer("0", true).is_err());
    }

    #[test]
    fn dates_and_ids_require_canonical_safe_values() {
        for value in ["2026-02-30", "2026-2-01", "0000-01-01"] {
            assert!(date(value).is_err());
        }
        assert!(id("00000000-0000-0000-0000-000000000000").is_err());
        assert!(instant("2026-10-06T12:00:00").is_err());
        for value in [
            "2026-10-06T12:00:60Z",
            "2026-10-06T12:00:00.0000000Z",
            "2026-10-06t12:00:00Z",
        ] {
            assert!(instant(value).is_err());
        }
        assert_eq!(
            instant("2026-10-06T12:00:00+03:00").unwrap(),
            "2026-10-06T09:00:00.000000Z"
        );
    }
}
