//! Complete synthetic provider exchanges; test seam is private to the module.
use super::{
    Requestor,
    ga4::{self, Definition, METRICS, Request, Workspace},
};
use crate::{
    error::Result,
    provider_credentials::{Credential, Crypto, ServiceAccount},
    provider_http::{Call, Page, Policy},
    provider_json,
};
use serde_json::{Value, json};
use std::{
    process::Command,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

struct Script {
    calls: Mutex<usize>,
    mutate: fn(usize, &str, Value) -> Value,
}
fn unchanged(_: usize, _: &str, value: Value) -> Value {
    value
}
fn catalog() -> Value {
    let dimensions: Vec<_> = [
        "landingPage",
        "deviceCategory",
        "sessionDefaultChannelGroup",
        "date",
        "unusedDimension",
    ]
    .iter()
    .map(|name| json!({"compatibility":"COMPATIBLE","dimensionMetadata":{"apiName":name}}))
    .collect();
    let metrics:Vec<_>=["unusedMetric","keyEvents","screenPageViews","sessions","activeUsers"].iter().map(|name|json!({"compatibility":"COMPATIBLE","metricMetadata":{"apiName":name,"type":if *name=="keyEvents"{"TYPE_FLOAT"}else{"TYPE_INTEGER"},"uiName":format!("Synthetic {name}"),"description":format!("Synthetic contract description for {name}")}})).collect();
    json!({"dimensionCompatibilities":dimensions,"metricCompatibilities":metrics})
}
fn definitions() -> Vec<Definition> {
    METRICS
        .iter()
        .map(|name| Definition {
            name: (*name).into(),
            kind: if *name == "keyEvents" {
                "TYPE_FLOAT".into()
            } else {
                "TYPE_INTEGER".into()
            },
            display_name: format!("Synthetic {name}"),
            description: format!("Synthetic contract description for {name}"),
        })
        .collect()
}
fn report(dimensions: Vec<String>, offset: usize, total: usize) -> Value {
    let rows:Vec<_>=(offset..(offset+200).min(total)).map(|index| {
        let values:Vec<_>=dimensions.iter().map(|name|json!({"value":match name.as_str() {"date"=>"20261001".into(),"sessionDefaultChannelGroup"=>"Organic Search".into(),"deviceCategory"=>"desktop".into(),"landingPage"=>format!("/synthetic/{index:04}"),_=>panic!("unsupported requested column")}})).collect();
        let mut row=json!({"metricValues":[{"value":"9007199254740993"},{"value":"27"},{"value":"81"},{"value":"1.3333333333333333"}]});if !dimensions.is_empty() {row["dimensionValues"]=json!(values);}row
    }).collect();
    json!({"kind":"analyticsData#runReport","dimensionHeaders":dimensions.iter().map(|name|json!({"name":name})).collect::<Vec<_>>(),"metricHeaders":definitions().iter().map(|d|json!({"name":d.name,"type":d.kind})).collect::<Vec<_>>(),"rows":rows,"rowCount":total,"metadata":{"timeZone":"Europe/Istanbul"}})
}
#[async_trait::async_trait]
impl Requestor for Script {
    async fn call(&self, origin: &str, call: Call<'_>) -> Result<Page> {
        let count = {
            let mut count = self.calls.lock().unwrap();
            *count += 1;
            *count
        };
        assert!(!call.body.windows(11).any(|b| b == b"PRIVATE KEY"));
        let value = if call.path == "/token" {
            assert_eq!(origin, "https://oauth2.googleapis.com");
            assert_eq!(call.method, http::Method::POST);
            assert!(call.authorization.is_empty());
            assert!(call.query.is_empty());
            assert_eq!(call.content_type, Some("application/x-www-form-urlencoded"));
            let form: std::collections::BTreeMap<_, _> = url::form_urlencoded::parse(call.body)
                .into_owned()
                .collect();
            assert_eq!(form.len(), 2);
            assert_eq!(
                form["grant_type"],
                "urn:ietf:params:oauth:grant-type:jwt-bearer"
            );
            assert_eq!(form["assertion"].split('.').count(), 3);
            json!({"access_token":"synthetic-private-token","token_type":"Bearer","expires_in":3600})
        } else {
            assert_eq!(call.authorization, "Bearer synthetic-private-token");
            if origin == "https://analyticsadmin.googleapis.com" {
                assert_eq!(call.method, http::Method::GET);
                assert_eq!(call.query, [("fields", "name,timeZone,deleteTime")]);
                json!({"name":"properties/123456","timeZone":"Europe/Istanbul"})
            } else {
                assert_eq!(origin, "https://analyticsdata.googleapis.com");
                assert_eq!(call.method, http::Method::POST);
                assert_eq!(call.content_type, Some("application/json"));
                let request = provider_json::parse(call.body).unwrap();
                assert_eq!(
                    request["metrics"],
                    json!(
                        METRICS
                            .iter()
                            .map(|name| json!({"name":name}))
                            .collect::<Vec<_>>()
                    )
                );
                if call.path.ends_with(":checkCompatibility") {
                    assert!(matches!(call.policy, Policy::Metadata));
                    assert_eq!(request["compatibilityFilter"], "COMPATIBLE");
                    assert_eq!(call.query.len(), 1);
                    catalog()
                } else {
                    assert!(call.path.ends_with(":runReport"));
                    assert!(matches!(call.policy, Policy::Report));
                    assert!(call.query.is_empty());
                    assert_eq!(request["limit"], "200");
                    assert_eq!(request["keepEmptyRows"], false);
                    assert_eq!(request["returnPropertyQuota"], false);
                    assert_eq!(
                        request["dateRanges"],
                        json!([{"startDate":"2026-10-01","endDate":"2026-10-06"}])
                    );
                    let dimensions: Vec<_> = request["dimensions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|d| d["name"].as_str().unwrap().to_owned())
                        .collect();
                    let total = if dimensions == ["landingPage"] {
                        1000
                    } else {
                        1
                    };
                    let offset = request["offset"].as_str().unwrap().parse().unwrap();
                    report(dimensions, offset, total)
                }
            }
        };
        let value = (self.mutate)(count, call.path, value);
        let raw = Zeroizing::new(serde_json::to_vec(&value).unwrap());
        Ok(Page {
            json: provider_json::parse(&raw)?,
            raw,
            total: None,
            pages: None,
        })
    }
}
async fn credential(crypto: &Crypto) -> Arc<ServiceAccount> {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("synthetic-only.pem");
    let generated = Command::new("openssl")
        .args([
            "genpkey",
            "-algorithm",
            "RSA",
            "-pkeyopt",
            "rsa_keygen_bits:2048",
            "-out",
        ])
        .arg(&file)
        .output()
        .unwrap();
    assert!(generated.status.success());
    let document = json!({"type":"service_account","client_email":"synthetic@sample-project.iam.gserviceaccount.com","private_key_id":"synthetic-key-id","private_key":std::fs::read_to_string(file).unwrap(),"token_uri":"https://oauth2.googleapis.com/token"});
    let Credential::Ga4(key) = crypto
        .parse(
            "ga4".into(),
            Zeroizing::new(serde_json::to_vec(&document).unwrap()),
        )
        .await
        .unwrap()
    else {
        panic!("wrong credential");
    };
    key
}
fn request() -> Request {
    Request {
        client: "f0000000-0000-4000-8000-000000000001".into(),
        connection: "f0000000-0000-4000-8000-000000000002".into(),
        property: "123456".into(),
        since: "2026-10-01".into(),
        until: "2026-10-06".into(),
    }
}
#[tokio::test]
async fn complete_five_table_collection_keeps_exact_observations_and_omits_private_accounts() {
    let crypto = Crypto::default();
    let script = Script {
        calls: Mutex::new(0),
        mutate: unchanged,
    };
    let workspace = ga4::fetch(&script, &crypto, credential(&crypto).await, request())
        .await
        .unwrap();
    assert_eq!(*script.calls.lock().unwrap(), 17);
    assert_eq!(workspace.landing.rows.len(), 1000);
    assert_eq!(
        workspace.summary.rows[0].metrics,
        ["9007199254740993", "27", "81", "1.3333333333333333"]
    );
    assert_eq!(workspace.daily.rows.len(), 1);
    assert!(workspace.summary.rows[0].dimensions.is_empty());
    let raw = serde_json::to_vec(&workspace).unwrap();
    let text = std::str::from_utf8(&raw).unwrap();
    assert!(!text.contains("123456"));
    assert!(!text.contains("private-token"));
    assert!(!text.contains("gserviceaccount"));
    assert!(!text.contains("PRIVATE KEY"));
    Workspace::decode(
        &raw,
        &request().client,
        &request().connection,
        "2026-10-01",
        "2026-10-06",
    )
    .unwrap();
    assert!(
        Workspace::decode(
            &raw,
            &request().connection,
            &request().client,
            "2026-10-01",
            "2026-10-06"
        )
        .is_err()
    );
    for field in ["summary", "daily", "acquisition", "devices", "landing"] {
        let mut value = serde_json::to_value(&workspace).unwrap();
        value[field]["rows"][0]["private_token"] = json!("private");
        assert!(
            Workspace::decode(
                &serde_json::to_vec(&value).unwrap(),
                &request().client,
                &request().connection,
                "2026-10-01",
                "2026-10-06"
            )
            .is_err()
        );
    }
}
#[tokio::test]
async fn later_page_quality_metadata_and_access_changes_fail_without_partial_workspace() {
    let crypto = Crypto::default();
    let key = credential(&crypto).await;
    for mutate in [
        (|count: usize, _: &str, mut value: Value| {
            if count == 16 {
                value["metadata"]["subjectToThresholding"] = json!(true);
            }
            value
        }) as fn(usize, &str, Value) -> Value,
        |count, _, mut value| {
            if count == 16 {
                value["rowCount"] = json!(999);
            }
            value
        },
        |count, _, mut value| {
            if count == 17 {
                value["timeZone"] = json!("UTC");
            }
            value
        },
        |count, _, mut value| {
            if count == 5 {
                value["metricCompatibilities"][1]["metricMetadata"]["description"] =
                    json!("Changed definition");
            }
            value
        },
        |count, _, mut value| {
            if count == 16 {
                value["rows"][0]["dimensionValues"][0]["value"] =
                    json!("/private?email=personal@example.com");
            }
            value
        },
        |count, _, mut value| {
            if count == 16 {
                value["rows"][1]["dimensionValues"][0]["value"] =
                    value["rows"][0]["dimensionValues"][0]["value"].clone();
            }
            value
        },
        |count, _, mut value| {
            if count == 16 {
                value["metadata"]["samplingMetadatas"] = json!([{"samplesReadCount":"1"}]);
            }
            value
        },
        |count, _, mut value| {
            if count == 16 {
                value["metadata"]["schemaRestrictionResponse"] =
                    json!({"activeMetricRestrictions":[{"metricName":"sessions"}]});
            }
            value
        },
    ] {
        let script = Script {
            calls: Mutex::new(0),
            mutate,
        };
        assert!(
            ga4::fetch(&script, &crypto, key.clone(), request())
                .await
                .is_err()
        );
    }
}
#[test]
fn metadata_and_quality_reject_blocked_columns_restrictions_and_sampling() {
    for field in ["blockedReasons", "expression", "customDefinition"] {
        let mut value = catalog();
        value["metricCompatibilities"][1]["metricMetadata"][field] = match field {
            "blockedReasons" => json!(["NO_REVENUE_METRICS"]),
            "expression" => json!("activeUsers*2"),
            _ => json!(true),
        };
        assert!(super::ga4_normalize::compatibility(&value, &[]).is_err());
    }
    let mut duplicate = catalog();
    let extra = duplicate["metricCompatibilities"][0].clone();
    duplicate["metricCompatibilities"]
        .as_array_mut()
        .unwrap()
        .push(extra);
    assert!(super::ga4_normalize::compatibility(&duplicate, &[]).is_err());
}
