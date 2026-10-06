use super::ga4::{Definition, METRICS, Report, Row, metadata_text, validate_definitions};
use crate::{
    error::{Error, Result},
    provider_json::{object, text},
};
use chrono::NaiveDate;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

fn array<'a>(object: &'a Map<String, Value>, key: &str, optional: bool) -> Result<&'a [Value]> {
    match object.get(key) {
        None if optional => Ok(&[]),
        Some(Value::Array(array)) => Ok(array),
        _ => Err(Error::Internal),
    }
}
fn false_or_absent(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).is_none_or(|v| v == &Value::Bool(false))
}
fn empty_array(object: &Map<String, Value>, key: &str) -> Result<()> {
    if array(object, key, true)?.is_empty() {
        Ok(())
    } else {
        Err(Error::Internal)
    }
}
pub(super) fn compatibility(value: &Value, dimensions: &[&str]) -> Result<Vec<Definition>> {
    let root = object(
        value,
        &["dimensionCompatibilities", "metricCompatibilities"],
    )?;
    let mut selected_dimensions = BTreeSet::new();
    let mut selected_metrics = BTreeMap::new();
    for (key, metadata, metric) in [
        ("dimensionCompatibilities", "dimensionMetadata", false),
        ("metricCompatibilities", "metricMetadata", true),
    ] {
        let catalog = array(root, key, !metric && dimensions.is_empty())?;
        if catalog.len() > 2048 {
            return Err(Error::Internal);
        }
        let mut seen = BTreeSet::new();
        for entry in catalog {
            let wrapper = object(entry, &["compatibility", metadata])?;
            if wrapper.len() != 2 {
                return Err(Error::Internal);
            }
            let fields = object(
                wrapper.get(metadata).ok_or(Error::Internal)?,
                if metric {
                    &[
                        "apiName",
                        "type",
                        "blockedReasons",
                        "customDefinition",
                        "expression",
                        "uiName",
                        "description",
                    ]
                } else {
                    &["apiName", "customDefinition"]
                },
            )?;
            let name = text(fields, "apiName")?;
            metadata_text(name, 256, false)?;
            if !seen.insert(name) {
                return Err(Error::Internal);
            }
            if !(if metric {
                METRICS.contains(&name)
            } else {
                dimensions.contains(&name)
            }) {
                continue;
            }
            if text(wrapper, "compatibility")? != "COMPATIBLE"
                || !false_or_absent(fields, "customDefinition")
            {
                return Err(Error::Internal);
            }
            if !metric {
                selected_dimensions.insert(name);
                continue;
            }
            let kind = text(fields, "type")?;
            if !matches!(kind, "TYPE_INTEGER" | "TYPE_FLOAT")
                || (name != "keyEvents" && kind != "TYPE_INTEGER")
                || fields
                    .get("expression")
                    .is_some_and(|v| v.as_str() != Some(""))
            {
                return Err(Error::Internal);
            }
            empty_array(fields, "blockedReasons")?;
            let display_name = text(fields, "uiName")?;
            let description = text(fields, "description")?;
            metadata_text(display_name, 256, false)?;
            metadata_text(description, 4096, true)?;
            selected_metrics.insert(
                name,
                Definition {
                    name: name.into(),
                    kind: kind.into(),
                    display_name: display_name.into(),
                    description: description.into(),
                },
            );
        }
    }
    if dimensions
        .iter()
        .any(|name| !selected_dimensions.contains(name))
    {
        return Err(Error::Internal);
    }
    let definitions = METRICS
        .iter()
        .map(|name| selected_metrics.remove(name).ok_or(Error::Internal))
        .collect::<Result<Vec<_>>>()?;
    validate_definitions(&definitions)?;
    Ok(definitions)
}
fn metadata(value: &Value, timezone: &str) -> Result<()> {
    let fields = object(
        value,
        &[
            "timeZone",
            "currencyCode",
            "emptyReason",
            "dataLossFromOtherRow",
            "subjectToThresholding",
            "schemaRestrictionResponse",
            "samplingMetadatas",
            "dataTruncationReasons",
        ],
    )?;
    if text(fields, "timeZone")? != timezone
        || !false_or_absent(fields, "dataLossFromOtherRow")
        || !false_or_absent(fields, "subjectToThresholding")
        || fields
            .get("emptyReason")
            .is_some_and(|v| v.as_str() != Some(""))
    {
        return Err(Error::Internal);
    }
    if let Some(currency) = fields.get("currencyCode") {
        let currency = currency.as_str().ok_or(Error::Internal)?;
        if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(Error::Internal);
        }
    }
    empty_array(fields, "samplingMetadatas")?;
    empty_array(fields, "dataTruncationReasons")?;
    if let Some(restrictions) = fields.get("schemaRestrictionResponse") {
        empty_array(
            object(restrictions, &["activeMetricRestrictions"])?,
            "activeMetricRestrictions",
        )?;
    }
    Ok(())
}
pub(super) fn page(
    value: &Value,
    report: &Report,
    definitions: &[Definition],
    offset: usize,
) -> Result<(usize, Vec<Row>)> {
    validate_definitions(definitions)?;
    let fields = object(
        value,
        &[
            "dimensionHeaders",
            "metricHeaders",
            "rows",
            "rowCount",
            "metadata",
            "kind",
            "totals",
            "maximums",
            "minimums",
        ],
    )?;
    if text(fields, "kind")? != "analyticsData#runReport" {
        return Err(Error::Internal);
    }
    metadata(
        fields.get("metadata").ok_or(Error::Internal)?,
        &report.timezone,
    )?;
    for key in ["totals", "maximums", "minimums"] {
        empty_array(fields, key)?;
    }
    let dimension_headers = array(fields, "dimensionHeaders", report.dimensions.is_empty())?;
    let metric_headers = array(fields, "metricHeaders", false)?;
    if dimension_headers.len() != report.dimensions.len() || metric_headers.len() != 4 {
        return Err(Error::Internal);
    }
    for (value, name) in dimension_headers.iter().zip(&report.dimensions) {
        let header = object(value, &["name"])?;
        if text(header, "name")? != name {
            return Err(Error::Internal);
        }
    }
    for (value, definition) in metric_headers.iter().zip(definitions) {
        let header = object(value, &["name", "type"])?;
        if text(header, "name")? != definition.name || text(header, "type")? != definition.kind {
            return Err(Error::Internal);
        }
    }
    let count = match fields.get("rowCount") {
        None => 0,
        Some(value) => value.as_u64().ok_or(Error::Internal)?,
    };
    if count > 1000
        || (report.dimensions.is_empty() && count > 1)
        || offset > count as usize
        || (offset > 0 && offset == count as usize)
    {
        return Err(Error::Internal);
    }
    let count = count as usize;
    let values = array(fields, "rows", true)?;
    if values.len() != 200.min(count - offset) {
        return Err(Error::Internal);
    }
    let mut rows = Vec::with_capacity(values.len());
    for value in values {
        let value = object(value, &["dimensionValues", "metricValues"])?;
        let dimensions = array(value, "dimensionValues", report.dimensions.is_empty())?;
        let metrics = array(value, "metricValues", false)?;
        if dimensions.len() != report.dimensions.len() || metrics.len() != 4 {
            return Err(Error::Internal);
        }
        let mut row = Row {
            dimensions: vec![],
            metrics: vec![],
        };
        for dimension in dimensions {
            row.dimensions
                .push(text(object(dimension, &["value"])?, "value")?.into());
        }
        for (metric, definition) in metrics.iter().zip(definitions) {
            let text = text(object(metric, &["value"])?, "value")?;
            row.metrics.push(if definition.kind == "TYPE_FLOAT" {
                decimal(text)?
            } else {
                integer(text)?;
                text.into()
            });
        }
        rows.push(row);
    }
    Ok((count, rows))
}
fn integer(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 18
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::Internal);
    }
    Ok(())
}
pub(super) fn decimal(raw: &str) -> Result<String> {
    if raw.is_empty() || raw.len() > 64 {
        return Err(Error::Internal);
    }
    let parts: Vec<_> = raw.split(['e', 'E']).collect();
    if parts.len() > 2 {
        return Err(Error::Internal);
    }
    let exponent = if parts.len() == 2 {
        let digits = parts[1].strip_prefix(['+', '-']).unwrap_or(parts[1]);
        if digits.is_empty() || digits.len() > 2 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::Internal);
        }
        let exponent = parts[1].parse::<i32>().map_err(|_| Error::Internal)?;
        if !(-18..=18).contains(&exponent) {
            return Err(Error::Internal);
        }
        exponent
    } else {
        0
    };
    let mantissa: Vec<_> = parts[0].split('.').collect();
    if mantissa.len() > 2 {
        return Err(Error::Internal);
    }
    integer(mantissa[0])?;
    let fraction = mantissa.get(1).copied().unwrap_or("");
    if mantissa.len() == 2
        && (fraction.is_empty()
            || fraction.len() > 18
            || !fraction.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(Error::Internal);
    }
    let mut digits = format!("{}{fraction}", mantissa[0]);
    let mut scale = fraction.len() as i32 - exponent;
    if scale < 0 {
        digits.push_str(&"0".repeat((-scale) as usize));
        scale = 0;
    }
    let scale = scale as usize;
    if digits.len() <= scale {
        digits = format!("{}{digits}", "0".repeat(scale - digits.len() + 1));
    }
    let (whole, fraction) = digits.split_at(digits.len() - scale);
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let fraction = fraction.trim_end_matches('0');
    if whole.len() > 18 || fraction.len() > 18 {
        return Err(Error::Internal);
    }
    Ok(if fraction.is_empty() {
        whole.into()
    } else {
        format!("{whole}.{fraction}")
    })
}
pub(super) fn validate_rows(report: &Report, definitions: &[Definition]) -> Result<()> {
    let mut previous: Option<&[String]> = None;
    for row in &report.rows {
        if row.dimensions.len() != report.dimensions.len()
            || row.metrics.len() != 4
            || previous.is_some_and(|p| p >= row.dimensions.as_slice())
        {
            return Err(Error::Internal);
        }
        previous = Some(&row.dimensions);
        for (name, value) in report.dimensions.iter().zip(&row.dimensions) {
            if value.len() > 1024
                || value.starts_with("RESERVED_")
                || value.chars().any(|c| c.is_control() || c == '\u{fffd}')
            {
                return Err(Error::Internal);
            }
            match name.as_str() {
                "date" => {
                    let date =
                        NaiveDate::parse_from_str(value, "%Y%m%d").map_err(|_| Error::Internal)?;
                    let calendar = date.format("%Y-%m-%d").to_string();
                    if date.format("%Y%m%d").to_string() != *value
                        || calendar < report.since
                        || calendar > report.until
                    {
                        return Err(Error::Internal);
                    }
                }
                "landingPage" => {
                    if value != "(not set)"
                        && (!value.starts_with('/')
                            || value.starts_with("//")
                            || value.contains(['?', '#', '@', '\\']))
                    {
                        return Err(Error::Internal);
                    }
                }
                "deviceCategory" | "sessionDefaultChannelGroup" => {
                    if value.is_empty() || value.len() > 256 {
                        return Err(Error::Internal);
                    }
                }
                _ => return Err(Error::Internal),
            }
        }
        for (definition, value) in definitions.iter().zip(&row.metrics) {
            if definition.kind == "TYPE_INTEGER" {
                integer(value)?;
            } else if decimal(value)? != *value {
                return Err(Error::Internal);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observed_attribution_remains_exact_and_bounded() {
        for (raw, expected) in [
            ("0", "0"),
            ("0.000", "0"),
            ("1.50", "1.5"),
            ("1.3333333333333333", "1.3333333333333333"),
            ("9.007199254740993e15", "9007199254740993"),
            ("1e-09", "0.000000001"),
            ("1E+02", "100"),
            ("0.000000000000000001", "0.000000000000000001"),
            ("999999999999999999", "999999999999999999"),
        ] {
            assert_eq!(decimal(raw).unwrap(), expected);
        }
        for raw in [
            "",
            "-0",
            "-1",
            "NaN",
            "Infinity",
            ".1",
            "1.",
            "01",
            "1e",
            "e1",
            "1ee1",
            "1e19",
            "1e-19",
            "1e+99",
            "1e1e1",
            "1.0e+100",
            "1000000000000000000",
            "0.0000000000000000001",
            "1 0",
            "1\n",
            "1e1\n",
        ] {
            assert!(decimal(raw).is_err(), "{raw}");
        }
    }
}
