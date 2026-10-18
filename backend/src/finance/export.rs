//! A bounded, current-authority page; never an unbounded private file job.
use crate::{
    db::Database,
    error::{Error, Result},
    query::Query,
    security::Actor,
};
use serde_json::{Value, json};
fn cell(value: &Value) -> String {
    let raw = match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => value.to_string(),
    };
    let raw = if raw
        .trim_start_matches(|c: char| c.is_whitespace() || c.is_control())
        .starts_with(['=', '+', '-', '@'])
    {
        format!("'{raw}")
    } else {
        raw
    };
    format!("\"{}\"", raw.replace('"', "\"\""))
}
pub async fn csv(db: &Database, actor: Actor, q: Query, report: String) -> Result<Value> {
    let data = if ["receivables", "payments", "clients"].contains(&report.as_str()) {
        super::reporting::details(db, actor, q.clone(), report.clone()).await?
    } else if report == "expenses" {
        let mut filters = Query::default();
        for key in [
            "currency",
            "client_id",
            "limit",
            "cursor",
            "category_id",
            "status",
            "q",
        ] {
            if let Some(value) = q.get(key) {
                filters.0.insert(key.into(), value.into());
            }
        }
        let position = super::expenses::list(db, actor, filters).await?;
        let mut metadata_query = Query::default();
        if let Some(currency) = q.get("currency") {
            metadata_query.0.insert("currency".into(), currency.into());
        }
        let filter = super::reporting::Filter::parse(&metadata_query)?;
        json!({"as_of":crate::validation::now(),"currency":filter.currency,"from":filter.from,"to":filter.to,"data":position["data"],"page":position["page"]})
    } else {
        let dashboard = super::reporting::dashboard(db, actor, q.clone()).await?;
        let key = match report.as_str() {
            "services" => "services",
            "partners" => "partners",
            "aging" => "aging",
            "cashflow" => "cashflow",
            _ => return Err(Error::NotFound),
        };
        let mut rows = dashboard[key].as_array().ok_or(Error::Denied)?.clone();
        let page = if key == "partners" {
            let p = q.paging()?;
            if let Some(cursor) = &p.cursor {
                rows.retain(|row| row["id"].as_str().is_some_and(|id| id > cursor.as_str()))
            }
            p.page(rows)?
        } else {
            json!({"data":rows,"page":{"next_cursor":null}})
        };
        json!({"as_of":dashboard["as_of"],"currency":dashboard["currency"],"from":dashboard["from"],"to":dashboard["to"],"data":page["data"],"page":page["page"]})
    };
    let columns: &[&str] = match report.as_str() {
        "receivables" => &[
            "id",
            "client_name",
            "currency",
            "description",
            "service_type",
            "amount_minor",
            "paid_minor",
            "outstanding_minor",
            "due_date",
            "status",
            "billed_on",
        ],
        "payments" => &[
            "id",
            "client_name",
            "collection_id",
            "kind",
            "amount_minor",
            "occurred_on",
            "recorded_at",
            "method",
            "collector",
        ],
        "clients" => &[
            "id",
            "client_name",
            "amount_minor",
            "paid_minor",
            "outstanding_minor",
            "overdue_minor",
            "count",
            "next_due",
            "last_payment_on",
            "activity_minor",
        ],
        "services" => &[
            "label",
            "activity_minor",
            "amount_minor",
            "paid_minor",
            "outstanding_minor",
            "count",
        ],
        "partners" => &[
            "id",
            "name",
            "contracted_minor",
            "roise_share_minor",
            "partner_share_minor",
            "roise_recognized_minor",
            "partner_recognized_minor",
            "settled_minor",
            "receivable_minor",
            "payable_minor",
            "balance_minor",
        ],
        "aging" => &["bucket", "amount_minor", "count", "clients"],
        "cashflow" => &[
            "period",
            "customer_minor",
            "incoming_minor",
            "outgoing_minor",
            "operating_minor",
            "net_minor",
        ],
        "expenses" => &[
            "id",
            "client_name",
            "category_name",
            "title",
            "vendor",
            "currency",
            "amount_minor",
            "paid_minor",
            "outstanding_minor",
            "expense_date",
            "due_date",
            "cancelled_at",
        ],
        _ => return Err(Error::NotFound),
    };
    let mut csv = String::from("\u{feff}");
    csv.push_str(&format!(
        "Report,{},Currency,{},As of,{},From,{},To,{}\r\n",
        cell(&json!(report)),
        cell(&data["currency"]),
        cell(&data["as_of"]),
        cell(&data["from"]),
        cell(&data["to"])
    ));
    csv.push_str("Definition,\"Amounts are exact integer minor units; current receivables are not historical balances. Payment activity uses business dates. This file is one bounded page; continue using next_cursor.\"\r\n");
    csv.push_str(&columns.join(","));
    csv.push_str("\r\n");
    for row in data["data"].as_array().ok_or(Error::Internal)? {
        csv.push_str(
            &columns
                .iter()
                .map(|k| cell(&row[*k]))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push_str("\r\n");
    }
    if csv.len() > 512 * 1024 {
        return Err(Error::Invalid("report_range_too_large"));
    }
    Ok(
        json!({"csv":csv,"next_cursor":data["page"]["next_cursor"],"as_of":data["as_of"],"currency":data["currency"],"report":report}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spreadsheet_cells_cannot_execute_formulas() {
        for s in ["=HYPERLINK(\"x\")", " +SUM(1)", "\t@X", "-1"] {
            assert!(cell(&json!(s)).starts_with("\"'"));
        }
        assert_eq!(cell(&json!("a\"b")), "\"a\"\"b\"");
    }
}
