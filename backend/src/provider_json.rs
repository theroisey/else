//! Duplicate-safe JSON interpretation before provider data reaches typed DTOs.
use crate::error::{Error, Result};
use serde::{
    Deserialize,
    de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Value};
use std::fmt;

struct Seed(usize);
impl<'de> DeserializeSeed<'de> for Seed {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Value, D::Error> {
        if self.0 > 32 {
            return Err(de::Error::custom("provider JSON unavailable"));
        }
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded unambiguous provider JSON")
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Value, E> {
        Ok(Value::from(value))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Value, E> {
        Ok(Value::from(value))
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> std::result::Result<Value, E> {
        Err(E::custom("provider JSON unavailable"))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Value, E> {
        Ok(Value::String(value.into()))
    }
    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Value, E> {
        Ok(Value::String(value))
    }
    fn visit_none<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> std::result::Result<Value, A::Error> {
        let mut result = Vec::new();
        while let Some(value) = sequence.next_element_seed(Seed(self.0 + 1))? {
            result.push(value);
        }
        Ok(Value::Array(result))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> std::result::Result<Value, A::Error> {
        let mut result = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if result.contains_key(&key) {
                return Err(de::Error::custom("provider JSON unavailable"));
            }
            result.insert(key, object.next_value_seed(Seed(self.0 + 1))?);
        }
        Ok(Value::Object(result))
    }
}
pub fn parse(raw: &[u8]) -> Result<Value> {
    let mut decoder = serde_json::Deserializer::from_slice(raw);
    let value = Seed(0)
        .deserialize(&mut decoder)
        .map_err(|_| Error::Internal)?;
    decoder.end().map_err(|_| Error::Internal)?;
    Ok(value)
}

pub fn object<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>> {
    let object = value.as_object().ok_or(Error::Internal)?;
    if object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err(Error::Internal);
    }
    Ok(object)
}
pub fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Error::Internal)
}
pub fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::Internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_fields_floats_trailing_values_and_deep_inputs_are_rejected() {
        for raw in [
            br#"{"id":1,"id":2}"#.as_slice(),
            br#"{"rows":[{"value":"1","value":"2"}]}"#,
            br#"{"amount":1.2}"#,
            br#"{}{}"#,
            br#"{"x":"\ud800"}"#,
        ] {
            assert!(parse(raw).is_err());
        }
        let deep = format!("{}0{}", "[".repeat(33), "]".repeat(33));
        assert!(parse(deep.as_bytes()).is_err());
        assert_eq!(parse(br#"{"value":"18446744073709551616.000000000000000001","count":18446744073709551615}"#).unwrap()["count"].as_u64(),Some(u64::MAX));
    }
}
