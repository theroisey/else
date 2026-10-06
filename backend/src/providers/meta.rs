//! Daily account observations and exact weighted rates, with no attribution
//! claims, fabricated missing days, provider URLs or private account identifiers.
use super::{Requestor, ga4::valid_timezone};
use crate::{
    error::{Error, Result},
    provider_credentials::ReadToken,
    provider_http::{Call, Policy},
    provider_json::{self, object, text},
    sync_period::Period,
    validation,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const ORIGIN: &str = "https://graph.facebook.com";
const METRIC_KEYS: [&str; 6] = [
    "spend_decimal",
    "impressions",
    "clicks",
    "ctr_percent",
    "cpc_decimal",
    "cpm_decimal",
];
pub(crate) struct Request {
    pub client: String,
    pub connection: String,
    pub account: String,
    pub since: String,
    pub until: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Metrics {
    pub spend_decimal: String,
    pub impressions: String,
    pub clicks: String,
    pub ctr_percent: Option<String>,
    pub cpc_decimal: Option<String>,
    pub cpm_decimal: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Day {
    pub date: String,
    pub spend_decimal: String,
    pub impressions: String,
    pub clicks: String,
    pub ctr_percent: Option<String>,
    pub cpc_decimal: Option<String>,
    pub cpm_decimal: Option<String>,
}
impl Day {
    fn new(date: String, m: Metrics) -> Self {
        Self {
            date,
            spend_decimal: m.spend_decimal,
            impressions: m.impressions,
            clicks: m.clicks,
            ctr_percent: m.ctr_percent,
            cpc_decimal: m.cpc_decimal,
            cpm_decimal: m.cpm_decimal,
        }
    }
    fn metrics(&self) -> Metrics {
        Metrics {
            spend_decimal: self.spend_decimal.clone(),
            impressions: self.impressions.clone(),
            clicks: self.clicks.clone(),
            ctr_percent: self.ctr_percent.clone(),
            cpc_decimal: self.cpc_decimal.clone(),
            cpm_decimal: self.cpm_decimal.clone(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub client_id: String,
    pub connection_id: String,
    pub graph_version: String,
    pub currency: String,
    pub timezone: String,
    pub since: String,
    pub until: String,
    pub days: Vec<Day>,
    pub totals: Metrics,
    pub attribution_status: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub report: Report,
    pub collected_from: String,
    pub collected_through: String,
}
impl Workspace {
    pub fn validate(&self, client: &str, connection: &str, since: &str, until: &str) -> Result<()> {
        let r = &self.report;
        validation::id(client).map_err(|_| Error::Internal)?;
        validation::id(connection).map_err(|_| Error::Internal)?;
        Period::calendar("meta_ads", since, until).map_err(|_| Error::Internal)?;
        super::collected_span(&self.collected_from, &self.collected_through)?;
        valid_timezone(&r.timezone)?;
        currency(&r.currency)?;
        if r.client_id != client
            || r.connection_id != connection
            || r.graph_version != "v26.0"
            || r.since != since
            || r.until != until
            || r.attribution_status != "unavailable"
            || r.days.len() > 31
        {
            return Err(Error::Internal);
        }
        let mut sums = [0i128; 3];
        let mut previous = "";
        for day in &r.days {
            validation::date(&day.date).map_err(|_| Error::Internal)?;
            if day.date.as_str() <= previous
                || day.date.as_str() < since
                || day.date.as_str() > until
            {
                return Err(Error::Internal);
            }
            previous = &day.date;
            let spend = spend(&day.spend_decimal)?;
            let impressions = count(&day.impressions)?;
            let clicks = count(&day.clicks)?;
            if day.metrics() != metrics(spend, impressions, clicks)? {
                return Err(Error::Internal);
            }
            for (sum, value) in sums.iter_mut().zip([spend, impressions, clicks]) {
                *sum = sum.checked_add(value).ok_or(Error::Internal)?;
            }
        }
        if r.totals != metrics(sums[0], sums[1], sums[2])? {
            return Err(Error::Internal);
        }
        Ok(())
    }
    pub fn decode(
        raw: &[u8],
        client: &str,
        connection: &str,
        since: &str,
        until: &str,
    ) -> Result<Self> {
        if raw.is_empty() || raw.len() > 2_097_152 {
            return Err(Error::Internal);
        }
        let value = provider_json::parse(raw)?;
        let root = object(&value, &["report", "collected_from", "collected_through"])?;
        if root.len() != 3 {
            return Err(Error::Internal);
        }
        let report = object(
            root.get("report").ok_or(Error::Internal)?,
            &[
                "client_id",
                "connection_id",
                "graph_version",
                "currency",
                "timezone",
                "since",
                "until",
                "days",
                "totals",
                "attribution_status",
            ],
        )?;
        if report.len() != 10
            || object(report.get("totals").ok_or(Error::Internal)?, &METRIC_KEYS)?.len() != 6
        {
            return Err(Error::Internal);
        }
        let days = report
            .get("days")
            .and_then(Value::as_array)
            .ok_or(Error::Internal)?;
        let mut keys = METRIC_KEYS.to_vec();
        keys.push("date");
        for day in days {
            if object(day, &keys)?.len() != 7 {
                return Err(Error::Internal);
            }
        }
        let workspace: Self = provider_json::decode(value)?;
        workspace.validate(client, connection, since, until)?;
        Ok(workspace)
    }
}
pub(super) async fn fetch(
    wire: &dyn Requestor,
    token: &ReadToken,
    request: Request,
) -> Result<Workspace> {
    validation::id(&request.client).map_err(|_| Error::Internal)?;
    validation::id(&request.connection).map_err(|_| Error::Internal)?;
    if !crate::integration_catalog::valid_account("ga4", &request.account) {
        return Err(Error::Internal);
    }
    Period::calendar("meta_ads", &request.since, &request.until).map_err(|_| Error::Internal)?;
    let authorization = token.authorization();
    let collected_from = super::collected_now()?;
    let permission_query = [("fields", "permission,status"), ("limit", "100")];
    read_permission(
        &get(
            wire,
            "/v26.0/me/permissions",
            &authorization,
            &permission_query,
        )
        .await?
        .json,
    )?;
    let account_path = format!("/v26.0/act_{}", request.account);
    let account_query = [("fields", "id,account_id,currency,timezone_name")];
    let context = account_context(
        &get(wire, &account_path, &authorization, &account_query)
            .await?
            .json,
        &request.account,
    )?;
    let range = serde_json::to_string(&json!({"since":request.since,"until":request.until}))
        .map_err(|_| Error::Internal)?;
    let insights_path = format!("{account_path}/insights");
    let query = [
        (
            "fields",
            "account_id,account_currency,date_start,date_stop,spend,impressions,clicks",
        ),
        ("level", "account"),
        ("time_increment", "1"),
        ("time_range", range.as_str()),
        ("limit", "31"),
    ];
    let mut pages = vec![];
    let mut cursor: Option<String> = None;
    let mut seen = BTreeSet::new();
    let mut finished = false;
    for _ in 0..4 {
        let mut query = query.to_vec();
        if let Some(cursor) = &cursor {
            query.push(("after", cursor.as_str()));
        }
        let page = get(wire, &insights_path, &authorization, &query).await?;
        let fields = object(&page.json, &["data", "paging"])?;
        let (next, after) = pagination(fields.get("paging"))?;
        if next && (after.is_empty() || !seen.insert(after.clone())) {
            return Err(Error::Internal);
        }
        pages.push(page);
        if !next {
            finished = true;
            break;
        }
        cursor = Some(after);
    }
    if !finished {
        return Err(Error::Internal);
    }
    let report = normalize(&request, &context, pages.iter().map(|p| &p.json))?;
    let head = get(wire, &insights_path, &authorization, &query).await?;
    if head.raw.as_slice() != pages[0].raw.as_slice() {
        return Err(Error::Internal);
    }
    if account_context(
        &get(wire, &account_path, &authorization, &account_query)
            .await?
            .json,
        &request.account,
    )? != context
    {
        return Err(Error::Internal);
    }
    read_permission(
        &get(
            wire,
            "/v26.0/me/permissions",
            &authorization,
            &permission_query,
        )
        .await?
        .json,
    )?;
    let result = Workspace {
        report,
        collected_from,
        collected_through: super::collected_now()?,
    };
    result.validate(
        &request.client,
        &request.connection,
        &request.since,
        &request.until,
    )?;
    Ok(result)
}
async fn get(
    wire: &dyn Requestor,
    path: &str,
    authorization: &str,
    query: &[(&str, &str)],
) -> Result<crate::provider_http::Page> {
    wire.call(
        ORIGIN,
        Call {
            method: http::Method::GET,
            path,
            query,
            body: &[],
            authorization,
            content_type: None,
            policy: Policy::Report,
            commerce_page: false,
        },
    )
    .await
}
fn read_permission(value: &Value) -> Result<()> {
    let page = object(value, &["data", "paging"])?;
    if pagination(page.get("paging"))?.0 {
        return Err(Error::Internal);
    }
    let rows = page
        .get("data")
        .and_then(Value::as_array)
        .ok_or(Error::Internal)?;
    if rows.len() > 100 {
        return Err(Error::Internal);
    }
    let mut seen = BTreeSet::new();
    let mut granted = false;
    for row in rows {
        let fields = object(row, &["permission", "status"])?;
        let name = text(fields, "permission")?;
        let status = text(fields, "status")?;
        if fields.len() != 2
            || name.is_empty()
            || name.len() > 128
            || !name.as_bytes()[0].is_ascii_lowercase()
            || !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            || !seen.insert(name)
            || !matches!(status, "granted" | "declined" | "expired")
        {
            return Err(Error::Internal);
        }
        granted |= name == "ads_read" && status == "granted";
    }
    if granted {
        Ok(())
    } else {
        Err(Error::Internal)
    }
}
fn account_context(value: &Value, account: &str) -> Result<(String, String)> {
    let fields = object(value, &["id", "account_id", "currency", "timezone_name"])?;
    if fields.len() != 4
        || text(fields, "id")? != format!("act_{account}")
        || text(fields, "account_id")? != account
    {
        return Err(Error::Internal);
    }
    let unit = text(fields, "currency")?;
    let timezone = text(fields, "timezone_name")?;
    currency(unit)?;
    valid_timezone(timezone)?;
    Ok((unit.into(), timezone.into()))
}
fn currency(unit: &str) -> Result<()> {
    if unit.len() == 3 && unit.bytes().all(|b| b.is_ascii_uppercase()) {
        Ok(())
    } else {
        Err(Error::Internal)
    }
}
fn pagination(value: Option<&Value>) -> Result<(bool, String)> {
    let Some(value) = value else {
        return Ok((false, String::new()));
    };
    let fields = object(value, &["cursors", "next", "previous"])?;
    for key in ["next", "previous"] {
        if fields.contains_key(key) {
            let link = text(fields, key)?;
            if link.is_empty() || link.len() > 8192 || link.contains(['\r', '\n', '\0']) {
                return Err(Error::Internal);
            }
        }
    }
    let mut cursor = String::new();
    if let Some(cursors) = fields.get("cursors") {
        let cursors = object(cursors, &["before", "after"])?;
        for (key, value) in cursors {
            let value = value.as_str().ok_or(Error::Internal)?;
            if value.is_empty()
                || value.len() > 256
                || !value.bytes().all(|b| (33..=126).contains(&b))
            {
                return Err(Error::Internal);
            }
            if key == "after" {
                cursor = value.into();
            }
        }
    }
    Ok((fields.contains_key("next"), cursor))
}
fn normalize<'a>(
    request: &Request,
    context: &(String, String),
    pages: impl Iterator<Item = &'a Value>,
) -> Result<Report> {
    let pages: Vec<_> = pages.collect();
    if pages.is_empty() || pages.len() > 4 {
        return Err(Error::Internal);
    }
    let mut days: BTreeMap<String, Day> = BTreeMap::new();
    let mut cursors = BTreeSet::new();
    let mut sums = [0i128; 3];
    for (index, page) in pages.iter().enumerate() {
        let fields = object(page, &["data", "paging"])?;
        let rows = fields
            .get("data")
            .and_then(Value::as_array)
            .ok_or(Error::Internal)?;
        let (next, cursor) = pagination(fields.get("paging"))?;
        if rows.len() > 31
            || next != (index + 1 < pages.len())
            || (next && (rows.is_empty() || cursor.is_empty() || !cursors.insert(cursor)))
        {
            return Err(Error::Internal);
        }
        for row in rows {
            let fields = object(
                row,
                &[
                    "account_id",
                    "account_currency",
                    "date_start",
                    "date_stop",
                    "spend",
                    "impressions",
                    "clicks",
                ],
            )?;
            let date = text(fields, "date_start")?;
            validation::date(date).map_err(|_| Error::Internal)?;
            if fields.len() != 7
                || text(fields, "account_id")? != request.account
                || text(fields, "account_currency")? != context.0
                || text(fields, "date_stop")? != date
                || date < request.since.as_str()
                || date > request.until.as_str()
                || days.contains_key(date)
                || days.len() >= 31
            {
                return Err(Error::Internal);
            }
            let spend = spend(text(fields, "spend")?)?;
            let impressions = count(text(fields, "impressions")?)?;
            let clicks = count(text(fields, "clicks")?)?;
            days.insert(
                date.into(),
                Day::new(date.into(), metrics(spend, impressions, clicks)?),
            );
            for (sum, value) in sums.iter_mut().zip([spend, impressions, clicks]) {
                *sum = sum.checked_add(value).ok_or(Error::Internal)?;
            }
        }
    }
    Ok(Report {
        client_id: request.client.clone(),
        connection_id: request.connection.clone(),
        graph_version: "v26.0".into(),
        currency: context.0.clone(),
        timezone: context.1.clone(),
        since: request.since.clone(),
        until: request.until.clone(),
        days: days.into_values().collect(),
        totals: metrics(sums[0], sums[1], sums[2])?,
        attribution_status: "unavailable".into(),
    })
}
fn count(value: &str) -> Result<i128> {
    if value.is_empty()
        || value.len() > 18
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::Internal);
    }
    value.parse().map_err(|_| Error::Internal)
}
fn spend(value: &str) -> Result<i128> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() > 2 {
        return Err(Error::Internal);
    }
    let whole = count(parts[0])?;
    let fraction = parts.get(1).copied().unwrap_or("");
    if parts.len() == 2
        && (fraction.is_empty()
            || fraction.len() > 6
            || !fraction.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(Error::Internal);
    }
    Ok(whole * 1_000_000
        + if fraction.is_empty() {
            0
        } else {
            fraction.parse::<i128>().map_err(|_| Error::Internal)?
                * 10i128.pow(6 - fraction.len() as u32)
        })
}
fn fixed(value: i128) -> String {
    format!("{}.{:06}", value / 1_000_000, value % 1_000_000)
}
fn ratio(numerator: i128, denominator: i128) -> Result<Option<String>> {
    if denominator == 0 {
        return Ok(None);
    }
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;
    Ok(Some(fixed(
        quotient
            + if remainder.checked_mul(2).ok_or(Error::Internal)? >= denominator {
                1
            } else {
                0
            },
    )))
}
fn metrics(spend: i128, impressions: i128, clicks: i128) -> Result<Metrics> {
    Ok(Metrics {
        spend_decimal: fixed(spend)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .into(),
        impressions: impressions.to_string(),
        clicks: clicks.to_string(),
        ctr_percent: ratio(
            clicks.checked_mul(100_000_000).ok_or(Error::Internal)?,
            impressions,
        )?,
        cpc_decimal: ratio(spend, clicks)?,
        cpm_decimal: ratio(spend.checked_mul(1000).ok_or(Error::Internal)?, impressions)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn financial_observations_and_half_up_ratios_remain_exact_beyond_javascript_numbers() {
        let m = metrics(
            spend("999999999999999999.123456").unwrap() + 1,
            count("999999999999999999").unwrap() + 3,
            4,
        )
        .unwrap();
        assert_eq!(m.spend_decimal, "999999999999999999.123457");
        assert_eq!(m.impressions, "1000000000000000002");
        let m = metrics(1, 3, 2).unwrap();
        assert_eq!(m.cpc_decimal.as_deref(), Some("0.000001"));
        assert_eq!(m.cpm_decimal.as_deref(), Some("0.000333"));
        assert_eq!(m.ctr_percent.as_deref(), Some("66.666667"));
        let empty = metrics(0, 0, 0).unwrap();
        assert_eq!(empty.spend_decimal, "0");
        assert!(empty.cpc_decimal.is_none());
        assert!(empty.cpm_decimal.is_none());
        assert!(empty.ctr_percent.is_none());
        for bad in [
            "-1",
            "+1",
            "01",
            "1e3",
            "NaN",
            " 1",
            "1000000000000000000",
            "1.1234567",
        ] {
            assert!(spend(bad).is_err());
            assert!(count(bad).is_err());
        }
    }
}
