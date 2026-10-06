//! The sole normalized publication/read boundary for all supported providers.
use super::{commerce, ga4, meta};
use crate::{
    error::{Error, Result},
    sync_period::Period,
};
use serde::Serialize;
#[derive(Serialize)]
#[serde(untagged)]
pub enum Workspace {
    Ga4(Box<ga4::Workspace>),
    Commerce(Box<commerce::Workspace>),
    Meta(Box<meta::Workspace>),
}
impl Workspace {
    pub fn validate(&self, client: &str, connection: &str, period: &Period) -> Result<()> {
        match (self, period) {
            (
                Self::Ga4(w),
                Period::Calendar {
                    provider,
                    since,
                    until,
                },
            ) if provider == "ga4" => w.validate(client, connection, since, until),
            (
                Self::Meta(w),
                Period::Calendar {
                    provider,
                    since,
                    until,
                },
            ) if provider == "meta_ads" => w.validate(client, connection, since, until),
            (
                Self::Commerce(w),
                Period::Commerce {
                    start,
                    end,
                    currency,
                },
            ) => w.validate(&commerce::Binding::new(
                client.into(),
                connection.into(),
                start.clone(),
                end.clone(),
                currency.clone(),
            )?),
            _ => Err(Error::Internal),
        }
    }
    pub fn decode(raw: &[u8], client: &str, connection: &str, period: &Period) -> Result<Self> {
        match period {
            Period::Calendar {
                provider,
                since,
                until,
            } if provider == "ga4" => Ok(Self::Ga4(Box::new(ga4::Workspace::decode(
                raw, client, connection, since, until,
            )?))),
            Period::Calendar {
                provider,
                since,
                until,
            } if provider == "meta_ads" => Ok(Self::Meta(Box::new(meta::Workspace::decode(
                raw, client, connection, since, until,
            )?))),
            Period::Commerce {
                start,
                end,
                currency,
            } => Ok(Self::Commerce(Box::new(commerce::Workspace::decode(
                raw,
                &commerce::Binding::new(
                    client.into(),
                    connection.into(),
                    start.clone(),
                    end.clone(),
                    currency.clone(),
                )?,
            )?))),
            _ => Err(Error::Internal),
        }
    }
    pub fn encode(&self) -> Result<String> {
        let raw = serde_json::to_string(self).map_err(|_| Error::Internal)?;
        if raw.is_empty() || raw.len() > 2_097_152 {
            return Err(Error::Internal);
        }
        Ok(raw)
    }
}
