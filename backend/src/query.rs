use crate::{
    error::{Error, Result},
    validation,
};
use rusqlite::{Row, types::ValueRef};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Clone, Default)]
pub struct Query(pub BTreeMap<String, String>);

impl Query {
    pub fn parse(raw: &str, keys: &[&str]) -> Result<Self> {
        if raw.len() > 4096 {
            return Err(Error::Invalid("invalid_request"));
        }
        let mut values = BTreeMap::new();
        let bytes = raw.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'%'
                && (index + 2 >= bytes.len()
                    || !bytes[index + 1].is_ascii_hexdigit()
                    || !bytes[index + 2].is_ascii_hexdigit())
            {
                return Err(Error::Invalid("invalid_request"));
            }
        }
        percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .map_err(|_| Error::Invalid("invalid_request"))?;
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            if !keys.contains(&key.as_ref())
                || value.is_empty()
                || values.contains_key(key.as_ref())
            {
                return Err(Error::Invalid("invalid_request"));
            }
            values.insert(key.into_owned(), value.into_owned());
        }
        Ok(Self(values))
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }

    pub fn choice<'a>(&'a self, key: &str, default: &'a str, options: &[&str]) -> Result<&'a str> {
        let value = self.get(key).unwrap_or(default);
        if options.contains(&value) {
            Ok(value)
        } else {
            Err(Error::Invalid("invalid_request"))
        }
    }

    pub fn text(&self, key: &str, max: usize) -> Result<String> {
        validation::text(self.get(key).unwrap_or(""), max, false, false)
    }

    pub fn paging(&self) -> Result<Paging> {
        let raw = self.get("limit").unwrap_or("25");
        if !raw.bytes().all(|c| c.is_ascii_digit()) {
            return Err(Error::Invalid("invalid_request"));
        }
        let limit = raw
            .parse::<usize>()
            .map_err(|_| Error::Invalid("invalid_request"))?;
        if !(1..=100).contains(&limit) {
            return Err(Error::Invalid("invalid_request"));
        }
        let cursor = self.get("cursor").map(validation::id).transpose()?;
        let descending = self.choice("sort", "id", &["id", "-id"])? == "-id";
        Ok(Paging {
            limit,
            cursor,
            descending,
        })
    }
}

#[derive(Clone)]
pub struct Paging {
    pub limit: usize,
    pub cursor: Option<String>,
    pub descending: bool,
}

impl Paging {
    pub fn comparison(&self) -> &'static str {
        if self.descending { "<" } else { ">" }
    }
    pub fn order(&self) -> &'static str {
        if self.descending { "DESC" } else { "ASC" }
    }
    pub fn page(&self, mut data: Vec<Value>) -> Result<Value> {
        let more = data.len() > self.limit;
        data.truncate(self.limit);
        let cursor = if more {
            Some(
                data.last()
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_str)
                    .ok_or(Error::Internal)?
                    .to_owned(),
            )
        } else {
            None
        };
        Ok(serde_json::json!({"data":data,"page":{"limit":self.limit,"next_cursor":cursor}}))
    }
}

#[derive(Serialize)]
pub struct Mutation {
    pub id: String,
    pub revision: i64,
}

pub fn next_revision(previous: i64, expected: i64) -> Result<i64> {
    if previous != expected || expected <= 0 || expected >= 9_007_199_254_740_991 {
        return Err(Error::Conflict("conflict"));
    }
    previous.checked_add(1).ok_or(Error::Conflict("conflict"))
}

/// Queries explicitly select public fields. JSON columns use an explicit _json alias.
pub fn row_json(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut output = Map::new();
    for (index, key) in row.as_ref().column_names().into_iter().enumerate() {
        let value = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(value)
                if [
                    "system_role",
                    "is_primary",
                    "needs_review",
                    "is_due",
                    "replayed",
                ]
                .contains(&key) =>
            {
                Value::Bool(value != 0)
            }
            ValueRef::Integer(value) => Value::from(value),
            ValueRef::Real(_) | ValueRef::Blob(_) => {
                return Err(rusqlite::Error::InvalidColumnType(
                    index,
                    key.to_owned(),
                    row.get_ref(index)?.data_type(),
                ));
            }
            ValueRef::Text(bytes) => {
                let text = std::str::from_utf8(bytes).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        index,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                if key.ends_with("_json") {
                    serde_json::from_str(text).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            index,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?
                } else {
                    Value::String(text.to_owned())
                }
            }
        };
        output.insert(key.strip_suffix("_json").unwrap_or(key).to_owned(), value);
    }
    Ok(Value::Object(output))
}
