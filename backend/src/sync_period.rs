//! Separate account-calendar ranges and half-open UTC commerce periods.
use crate::{
    billing,
    error::{Error, Result},
    validation,
};
use chrono::{DateTime, Datelike, NaiveDate, SecondsFormat, Utc};

#[derive(Clone, PartialEq, Eq)]
pub enum Period {
    Calendar {
        provider: String,
        since: String,
        until: String,
    },
    Commerce {
        start: String,
        end: String,
        currency: String,
    },
}
impl Period {
    pub fn calendar(provider: &str, since: &str, until: &str) -> Result<Self> {
        if !matches!(provider, "ga4" | "meta_ads") {
            return Err(Error::Invalid("invalid_request"));
        }
        validation::date(since)?;
        validation::date(until)?;
        let start = NaiveDate::parse_from_str(since, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("invalid_request"))?;
        let end = NaiveDate::parse_from_str(until, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("invalid_request"))?;
        if start.year() < 2000 || end < start || (end - start).num_days() > 30 {
            return Err(Error::Invalid("invalid_request"));
        }
        Ok(Self::Calendar {
            provider: provider.into(),
            since: since.into(),
            until: until.into(),
        })
    }
    pub fn commerce(start: &str, end: &str, currency: &str) -> Result<Self> {
        let parse = |raw: &str| -> Result<DateTime<Utc>> {
            let value = DateTime::parse_from_rfc3339(raw)
                .map_err(|_| Error::Invalid("invalid_request"))?
                .with_timezone(&Utc);
            if value.year() < 2000
                || value.year() > 9999
                || value.timestamp_subsec_nanos() != 0
                || value.to_rfc3339_opts(SecondsFormat::Secs, true) != raw
            {
                return Err(Error::Invalid("invalid_request"));
            }
            Ok(value)
        };
        let since = parse(start)?;
        let until = parse(end)?;
        billing::exponent(currency)?;
        if until <= since || (until - since).num_seconds() > 31 * 86_400 {
            return Err(Error::Invalid("invalid_request"));
        }
        Ok(Self::Commerce {
            start: start.into(),
            end: end.into(),
            currency: currency.into(),
        })
    }
    pub fn provider(&self) -> &str {
        match self {
            Self::Calendar { provider, .. } => provider,
            Self::Commerce { .. } => "woocommerce",
        }
    }
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Calendar {
                provider,
                since,
                until,
            } => Self::calendar(provider, since, until).map(|_| ()),
            Self::Commerce {
                start,
                end,
                currency,
            } => Self::commerce(start, end, currency).map(|_| ()),
        }
    }
    pub(crate) fn columns(&self) -> [Option<String>; 5] {
        match self {
            Self::Calendar { since, until, .. } => {
                [Some(since.clone()), Some(until.clone()), None, None, None]
            }
            Self::Commerce {
                start,
                end,
                currency,
            } => [
                None,
                None,
                Some(format!("{}.000000Z", start.trim_end_matches('Z'))),
                Some(format!("{}.000000Z", end.trim_end_matches('Z'))),
                Some(currency.clone()),
            ],
        }
    }
    pub(crate) fn stored(provider: String, fields: [Option<String>; 5]) -> Result<Self> {
        let [since, until, start, end, currency] = fields;
        let value = match (provider.as_str(), since, until, start, end, currency) {
            ("ga4" | "meta_ads", Some(since), Some(until), None, None, None) => {
                Self::calendar(&provider, &since, &until)
            }
            ("woocommerce", None, None, Some(start), Some(end), Some(currency)) => {
                let (Some(start), Some(end)) =
                    (start.strip_suffix(".000000Z"), end.strip_suffix(".000000Z"))
                else {
                    return Err(Error::Internal);
                };
                Self::commerce(&format!("{start}Z"), &format!("{end}Z"), &currency)
            }
            _ => Err(Error::Internal),
        };
        value.map_err(|_| Error::Internal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_periods_keep_calendar_dates_and_exact_half_open_utc_seconds() {
        assert!(Period::calendar("ga4", "2026-03-07", "2026-04-06").is_ok());
        for (a, b) in [
            ("1999-12-31", "2000-01-01"),
            ("2026-02-30", "2026-03-01"),
            ("2026-03-01", "2026-04-01"),
            ("2026-03-02", "2026-03-01"),
        ] {
            assert!(Period::calendar("ga4", a, b).is_err());
        }
        let period =
            Period::commerce("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "KWD").unwrap();
        assert!(Period::stored(period.provider().into(), period.columns()).unwrap() == period);
        for start in [
            "2026-03-01T00:00:00+00:00",
            "2026-03-01T00:00:00.0Z",
            "2026-03-01T00:00:60Z",
        ] {
            assert!(Period::commerce(start, "2026-04-01T00:00:00Z", "USD").is_err());
        }
        assert!(Period::commerce("2026-03-01T00:00:00Z", "2026-04-01T00:00:01Z", "USD").is_err());
        assert!(Period::commerce("2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z", "USD").is_err());
    }
}
