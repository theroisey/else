//! Five complete GA4 aggregate tables; no invented nonadditive period totals.
use super::{Requestor, ga4_normalize};
use crate::{
    error::{Error, Result},
    integration_catalog,
    provider_credentials::{AccessToken, Crypto, ServiceAccount},
    provider_http::{Call, Policy},
    provider_json::{self, object, text},
    sync_period::Period,
    validation,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

const DATA_ORIGIN: &str = "https://analyticsdata.googleapis.com";
const ADMIN_ORIGIN: &str = "https://analyticsadmin.googleapis.com";
pub(super) const METRICS: [&str; 4] = ["activeUsers", "sessions", "screenPageViews", "keyEvents"];
const TEMPLATES: [&[&str]; 5] = [
    &[],
    &["date"],
    &["date", "sessionDefaultChannelGroup"],
    &["date", "deviceCategory"],
    &["landingPage"],
];
pub(crate) struct Request {
    pub client: String,
    pub connection: String,
    pub property: String,
    pub since: String,
    pub until: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub display_name: String,
    pub description: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Row {
    pub dimensions: Vec<String>,
    pub metrics: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub client_id: String,
    pub connection_id: String,
    pub api_version: String,
    pub timezone: String,
    pub since: String,
    pub until: String,
    pub dimensions: Vec<String>,
    pub metrics: Vec<String>,
    pub rows: Vec<Row>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub definitions: Vec<Definition>,
    pub summary: Report,
    pub daily: Report,
    pub acquisition: Report,
    pub devices: Report,
    pub landing: Report,
}
impl Workspace {
    pub fn validate(&self, client: &str, connection: &str, since: &str, until: &str) -> Result<()> {
        validation::id(client).map_err(|_| Error::Internal)?;
        validation::id(connection).map_err(|_| Error::Internal)?;
        Period::calendar("ga4", since, until).map_err(|_| Error::Internal)?;
        validate_definitions(&self.definitions)?;
        let timezone = &self.summary.timezone;
        valid_timezone(timezone)?;
        for (report, dimensions) in [
            &self.summary,
            &self.daily,
            &self.acquisition,
            &self.devices,
            &self.landing,
        ]
        .into_iter()
        .zip(TEMPLATES)
        {
            if report.client_id != client
                || report.connection_id != connection
                || report.api_version != "v1beta"
                || report.timezone != *timezone
                || report.since != since
                || report.until != until
                || report.dimensions != dimensions
                || report.metrics != METRICS
                || report.rows.len() > 1000
                || (dimensions.is_empty() && report.rows.len() > 1)
            {
                return Err(Error::Internal);
            }
            ga4_normalize::validate_rows(report, &self.definitions)?;
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
        let value: Self = provider_json::decode(provider_json::parse(raw)?)?;
        value.validate(client, connection, since, until)?;
        Ok(value)
    }
}
pub(super) async fn fetch(
    wire: &dyn Requestor,
    crypto: &Crypto,
    credential: Arc<ServiceAccount>,
    request: Request,
) -> Result<Workspace> {
    validation::id(&request.client).map_err(|_| Error::Internal)?;
    validation::id(&request.connection).map_err(|_| Error::Internal)?;
    Period::calendar("ga4", &request.since, &request.until).map_err(|_| Error::Internal)?;
    if !integration_catalog::valid_account("ga4", &request.property) {
        return Err(Error::Internal);
    }
    let now = Utc::now();
    let form = credential.token_form(crypto, now).await?;
    let response = wire
        .call(
            "https://oauth2.googleapis.com",
            Call {
                method: http::Method::POST,
                path: "/token",
                query: &[],
                body: form.as_bytes(),
                authorization: "",
                content_type: Some("application/x-www-form-urlencoded"),
                policy: Policy::Report,
                commerce_page: false,
            },
        )
        .await?;
    let token = AccessToken::parse(response.json, now)?;
    let timezone = property_timezone(wire, &token, &request.property).await?;
    let mut reports = Vec::with_capacity(5);
    let mut definitions: Option<Vec<Definition>> = None;
    for dimensions in TEMPLATES {
        let verified = compatibility(wire, &token, &request.property, dimensions).await?;
        if definitions
            .as_ref()
            .is_some_and(|previous| previous != &verified)
        {
            return Err(Error::Internal);
        }
        let report = report(wire, &token, &request, &timezone, dimensions, &verified).await?;
        reports.push(report);
        definitions = Some(verified);
    }
    if property_timezone(wire, &token, &request.property).await? != timezone {
        return Err(Error::Internal);
    }
    let mut reports = reports.into_iter();
    let mut take = || reports.next().ok_or(Error::Internal);
    let result = Workspace {
        definitions: definitions.ok_or(Error::Internal)?,
        summary: take()?,
        daily: take()?,
        acquisition: take()?,
        devices: take()?,
        landing: take()?,
    };
    result.validate(
        &request.client,
        &request.connection,
        &request.since,
        &request.until,
    )?;
    Ok(result)
}
async fn property_timezone(wire: &dyn Requestor, token: &AccessToken, id: &str) -> Result<String> {
    let authorization = token.authorization(Utc::now())?;
    let path = format!("/v1beta/properties/{id}");
    let response = wire
        .call(
            ADMIN_ORIGIN,
            Call {
                method: http::Method::GET,
                path: &path,
                query: &[("fields", "name,timeZone,deleteTime")],
                body: &[],
                authorization: &authorization,
                content_type: None,
                policy: Policy::Report,
                commerce_page: false,
            },
        )
        .await?;
    let fields = object(&response.json, &["name", "timeZone", "deleteTime"])?;
    if text(fields, "name")? != format!("properties/{id}") || fields.contains_key("deleteTime") {
        return Err(Error::Internal);
    }
    let timezone = text(fields, "timeZone")?;
    valid_timezone(timezone)?;
    Ok(timezone.into())
}
fn named(names: &[&str]) -> Value {
    Value::Array(names.iter().map(|name| json!({"name":name})).collect())
}
async fn compatibility(
    wire: &dyn Requestor,
    token: &AccessToken,
    id: &str,
    dimensions: &[&str],
) -> Result<Vec<Definition>> {
    let authorization = token.authorization(Utc::now())?;
    let path = format!("/v1beta/properties/{id}:checkCompatibility");
    let body=serde_json::to_vec(&json!({"dimensions":named(dimensions),"metrics":named(&METRICS),"compatibilityFilter":"COMPATIBLE"})).map_err(|_|Error::Internal)?;
    let projection = "dimensionCompatibilities(compatibility,dimensionMetadata(apiName,customDefinition)),metricCompatibilities(compatibility,metricMetadata(apiName,type,blockedReasons,customDefinition,expression,uiName,description))";
    let response = wire
        .call(
            DATA_ORIGIN,
            Call {
                method: http::Method::POST,
                path: &path,
                query: &[("fields", projection)],
                body: &body,
                authorization: &authorization,
                content_type: Some("application/json"),
                policy: Policy::Metadata,
                commerce_page: false,
            },
        )
        .await?;
    ga4_normalize::compatibility(&response.json, dimensions)
}
async fn report(
    wire: &dyn Requestor,
    token: &AccessToken,
    request: &Request,
    timezone: &str,
    dimensions: &[&str],
    definitions: &[Definition],
) -> Result<Report> {
    let mut result = Report {
        client_id: request.client.clone(),
        connection_id: request.connection.clone(),
        api_version: "v1beta".into(),
        timezone: timezone.into(),
        since: request.since.clone(),
        until: request.until.clone(),
        dimensions: dimensions.iter().map(|s| (*s).into()).collect(),
        metrics: METRICS.iter().map(|s| (*s).into()).collect(),
        rows: vec![],
    };
    let mut total = None;
    for _ in 0..5 {
        let offset = result.rows.len();
        let authorization = token.authorization(Utc::now())?;
        let path = format!("/v1beta/properties/{}:runReport", request.property);
        let orders:Vec<_>=dimensions.iter().map(|name|json!({"dimension":{"dimensionName":name,"orderType":"ALPHANUMERIC"},"desc":false})).collect();
        let body=serde_json::to_vec(&json!({"dimensions":named(dimensions),"metrics":named(&METRICS),"dateRanges":[{"startDate":request.since,"endDate":request.until}],"offset":offset.to_string(),"limit":"200","orderBys":orders,"keepEmptyRows":false,"returnPropertyQuota":false})).map_err(|_|Error::Internal)?;
        let response = wire
            .call(
                DATA_ORIGIN,
                Call {
                    method: http::Method::POST,
                    path: &path,
                    query: &[],
                    body: &body,
                    authorization: &authorization,
                    content_type: Some("application/json"),
                    policy: Policy::Report,
                    commerce_page: false,
                },
            )
            .await?;
        let (count, rows) = ga4_normalize::page(&response.json, &result, definitions, offset)?;
        if total.is_some_and(|old| old != count) {
            return Err(Error::Internal);
        }
        total = Some(count);
        result.rows.extend(rows);
        if result.rows.len() == count {
            break;
        }
    }
    if total != Some(result.rows.len()) {
        return Err(Error::Internal);
    }
    ga4_normalize::validate_rows(&result, definitions)?;
    Ok(result)
}
pub(super) fn valid_timezone(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || value == "Local"
        || value.parse::<chrono_tz::Tz>().is_err()
    {
        return Err(Error::Internal);
    }
    Ok(())
}
pub(super) fn metadata_text(value: &str, maximum: usize, multiline: bool) -> Result<()> {
    if value.is_empty()
        || value.len() > maximum
        || value.chars().any(|c| {
            c == '\u{fffd}' || (c.is_control() && !(multiline && matches!(c, '\n' | '\t')))
        })
    {
        return Err(Error::Internal);
    }
    Ok(())
}
pub(super) fn validate_definitions(definitions: &[Definition]) -> Result<()> {
    if definitions.len() != 4 {
        return Err(Error::Internal);
    }
    for (i, definition) in definitions.iter().enumerate() {
        if definition.name != METRICS[i]
            || !matches!(definition.kind.as_str(), "TYPE_INTEGER" | "TYPE_FLOAT")
            || (i < 3 && definition.kind != "TYPE_INTEGER")
        {
            return Err(Error::Internal);
        }
        metadata_text(&definition.display_name, 256, false)?;
        metadata_text(&definition.description, 4096, true)?;
    }
    Ok(())
}
