use super::{
    Requestor,
    meta::{self, Request, Workspace},
};
use crate::{
    error::{Error, Result},
    provider_credentials::{Credential, Crypto, ReadToken},
    provider_http::{Call, Page},
    provider_json,
};
use serde_json::{Value, json};
use std::sync::Mutex;
use zeroize::Zeroizing;
fn request() -> Request {
    Request {
        client: "c1000000-0000-4000-8000-000000000001".into(),
        connection: "c2000000-0000-4000-8000-000000000001".into(),
        account: "123456789".into(),
        since: "2026-03-07".into(),
        until: "2026-03-09".into(),
    }
}
fn row(date: &str, spend: &str, impressions: &str, clicks: &str) -> Value {
    json!({"account_id":"123456789","account_currency":"USD","date_start":date,"date_stop":date,"spend":spend,"impressions":impressions,"clicks":clicks})
}
fn first_page() -> Value {
    json!({"data":[row("2026-03-09","2.00","1","1")],"paging":{"cursors":{"after":"synthetic-after"},"next":"https://synthetic.invalid/?access_token=DO_NOT_RETURN"}})
}
fn last_page() -> Value {
    json!({"data":[row("2026-03-07","1.000000","100","1")]})
}
struct Script {
    calls: Mutex<usize>,
    mutate: fn(usize, Value) -> Value,
    fail: usize,
}
#[async_trait::async_trait]
impl Requestor for Script {
    async fn call(&self, origin: &str, call: Call<'_>) -> Result<Page> {
        assert_eq!(origin, "https://graph.facebook.com");
        assert_eq!(call.method, http::Method::GET);
        assert_eq!(call.authorization, "Bearer SyntheticReadTokenFixture123456");
        assert!(call.body.is_empty());
        assert!(call.content_type.is_none());
        assert!(!call.query.iter().any(|(k, _)| k.contains("token")));
        let count = {
            let mut count = self.calls.lock().unwrap();
            *count += 1;
            *count
        };
        if count == self.fail {
            return Err(Error::Internal);
        }
        let value = match call.path {
            "/v26.0/me/permissions" => {
                assert_eq!(
                    call.query,
                    [("fields", "permission,status"), ("limit", "100")]
                );
                json!({"data":[{"permission":"public_profile","status":"granted"},{"permission":"ads_read","status":"granted"}]})
            }
            "/v26.0/act_123456789" => {
                assert_eq!(
                    call.query,
                    [("fields", "id,account_id,currency,timezone_name")]
                );
                json!({"id":"act_123456789","account_id":"123456789","currency":"USD","timezone_name":"America/New_York"})
            }
            "/v26.0/act_123456789/insights" => {
                let query: std::collections::BTreeMap<_, _> = call.query.iter().copied().collect();
                assert_eq!(
                    query["fields"],
                    "account_id,account_currency,date_start,date_stop,spend,impressions,clicks"
                );
                assert_eq!(query["level"], "account");
                assert_eq!(query["time_increment"], "1");
                assert_eq!(query["limit"], "31");
                assert_eq!(
                    provider_json::parse(query["time_range"].as_bytes()).unwrap(),
                    json!({"since":"2026-03-07","until":"2026-03-09"})
                );
                match query.get("after") {
                    None => first_page(),
                    Some(&"synthetic-after") => last_page(),
                    _ => panic!("unexpected cursor"),
                }
            }
            _ => panic!("unexpected path"),
        };
        let value = (self.mutate)(count, value);
        let raw = Zeroizing::new(serde_json::to_vec(&value).unwrap());
        Ok(Page {
            json: provider_json::parse(&raw)?,
            raw,
            total: None,
            pages: None,
        })
    }
}
async fn token() -> ReadToken {
    let Credential::Meta(token) = Crypto::default()
        .parse(
            "meta_ads".into(),
            Zeroizing::new(b"SyntheticReadTokenFixture123456".to_vec()),
        )
        .await
        .unwrap()
    else {
        panic!("wrong credential");
    };
    token
}
fn unchanged(_: usize, value: Value) -> Value {
    value
}
#[tokio::test]
async fn daily_reports_keep_weighted_rates_and_discard_private_navigation_and_missing_days() {
    let script = Script {
        calls: Mutex::new(0),
        mutate: unchanged,
        fail: 0,
    };
    let workspace = meta::fetch(&script, &token().await, request())
        .await
        .unwrap();
    assert_eq!(*script.calls.lock().unwrap(), 7);
    let r = &workspace.report;
    assert_eq!(r.days.len(), 2);
    assert_eq!(r.days[0].date, "2026-03-07");
    assert_eq!(r.totals.spend_decimal, "3");
    assert_eq!(r.totals.impressions, "101");
    assert_eq!(r.totals.clicks, "2");
    assert_eq!(r.totals.ctr_percent.as_deref(), Some("1.980198"));
    assert_eq!(r.totals.cpc_decimal.as_deref(), Some("1.500000"));
    assert_eq!(r.totals.cpm_decimal.as_deref(), Some("29.702970"));
    assert_eq!(r.attribution_status, "unavailable");
    let raw = serde_json::to_vec(&workspace).unwrap();
    let text = std::str::from_utf8(&raw).unwrap();
    for private in [
        "123456789",
        "DO_NOT_RETURN",
        "synthetic-after",
        "SyntheticReadToken",
        "synthetic.invalid",
        "2026-03-08",
    ] {
        assert!(!text.contains(private));
    }
    Workspace::decode(
        &raw,
        &request().client,
        &request().connection,
        "2026-03-07",
        "2026-03-09",
    )
    .unwrap();
    for pointer in [
        "/report/totals/ctr_percent",
        "/report/days/0/cpc_decimal",
        "/report/totals/spend_decimal",
        "/report/attribution_status",
    ] {
        let mut value = serde_json::to_value(&workspace).unwrap();
        *value.pointer_mut(pointer).unwrap() = json!("wrong");
        assert!(
            Workspace::decode(
                &serde_json::to_vec(&value).unwrap(),
                &request().client,
                &request().connection,
                "2026-03-07",
                "2026-03-09"
            )
            .is_err()
        );
    }
    let mut value = serde_json::to_value(&workspace).unwrap();
    value["report"]["totals"]
        .as_object_mut()
        .unwrap()
        .remove("ctr_percent");
    assert!(
        Workspace::decode(
            &serde_json::to_vec(&value).unwrap(),
            &request().client,
            &request().connection,
            "2026-03-07",
            "2026-03-09"
        )
        .is_err()
    );
}
#[tokio::test]
async fn every_request_failure_and_changed_permissions_context_or_heads_are_atomic() {
    let token = token().await;
    for fail in 1..=7 {
        let script = Script {
            calls: Mutex::new(0),
            mutate: unchanged,
            fail,
        };
        assert!(meta::fetch(&script, &token, request()).await.is_err());
        assert_eq!(*script.calls.lock().unwrap(), fail);
    }
    for mutate in [
        (|count: usize, mut value: Value| {
            if count == 1 {
                value["data"][1]["permission"] = json!("ads_management");
            }
            value
        }) as fn(usize, Value) -> Value,
        |count, mut value| {
            if count == 7 {
                value["data"][1]["status"] = json!("expired");
            }
            value
        },
        |count, mut value| {
            if count == 6 {
                value["currency"] = json!("EUR");
            }
            value
        },
        |count, mut value| {
            if count == 6 {
                value["timezone_name"] = json!("UTC");
            }
            value
        },
        |count, mut value| {
            if count == 5 {
                value["data"][0]["spend"] = json!("2.01");
            }
            value
        },
        |count, mut value| {
            if count == 4 {
                value["data"][0]["account_currency"] = json!("EUR");
            }
            value
        },
        |count, mut value| {
            if count == 4 {
                value["paging"] = json!({"next":"https://synthetic.invalid","cursors":{"after":"synthetic-after"}});
            }
            value
        },
    ] {
        let script = Script {
            calls: Mutex::new(0),
            mutate,
            fail: 0,
        };
        assert!(meta::fetch(&script, &token, request()).await.is_err());
    }
}
