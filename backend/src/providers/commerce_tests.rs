use super::{
    Requestor,
    commerce::{self, Binding, Workspace},
};
use crate::{
    error::{Error, Result},
    provider_credentials::{Credential, Crypto, ReadKey},
    provider_http::{Call, Page},
    provider_json,
};
use base64::Engine;
use serde_json::{Value, json};
use std::sync::Mutex;
use zeroize::Zeroizing;
fn binding() -> Binding {
    Binding::new(
        "c1000000-0000-4000-8000-000000000001".into(),
        "c2000000-0000-4000-8000-000000000001".into(),
        "2026-10-01T00:00:00Z".into(),
        "2026-10-08T00:00:00Z".into(),
        "USD".into(),
    )
    .unwrap()
}
struct Script {
    orders: usize,
    refunds: usize,
    calls: Mutex<usize>,
    mutate: fn(usize, Page) -> Page,
    fail: usize,
}
fn unchanged(_: usize, page: Page) -> Page {
    page
}
fn order(id: usize) -> Value {
    json!({"id":id,"status":"pending","currency":"USD","date_created_gmt":"2026-10-01T00:00:00","total":"100.000000","refunds":[],"line_items":[{"id":10000+id,"product_id":3,"variation_id":0,"quantity":2,"total":"90.000000","total_tax":"10.000000"}]})
}
fn refund(id: usize) -> Value {
    json!({"id":20000+id,"parent_id":id,"date_created_gmt":"2026-10-01T12:00:00","amount":"1.000000"})
}
#[async_trait::async_trait]
impl Requestor for Script {
    async fn call(&self, origin: &str, call: Call<'_>) -> Result<Page> {
        assert_eq!(origin, "https://shop.example/wordpress");
        assert_eq!(call.method, http::Method::GET);
        assert!(call.commerce_page);
        assert!(call.body.is_empty());
        assert!(call.content_type.is_none());
        let header = call.authorization.strip_prefix("Basic ").unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(header)
                .unwrap(),
            format!("ck_{}:cs_{}", "a".repeat(40), "b".repeat(40)).as_bytes()
        );
        let count = {
            let mut count = self.calls.lock().unwrap();
            *count += 1;
            *count
        };
        if count == self.fail {
            return Err(Error::Internal);
        }
        let query: std::collections::BTreeMap<_, _> = call.query.iter().copied().collect();
        assert!(
            query
                .keys()
                .all(|key| !key.contains("consumer") && !key.contains("token"))
        );
        let (rows, total, pages) = if let Some(include) = query.get("include") {
            assert_eq!(call.path, "/wp-json/wc/v3/orders");
            assert_eq!(query["_fields"], "id,currency");
            assert!(!query.contains_key("after"));
            assert!(!query.contains_key("before"));
            assert_eq!(query["per_page"], "50");
            assert_eq!(query["page"], "1");
            let ids: Vec<usize> = include.split(',').map(|id| id.parse().unwrap()).collect();
            let rows: Vec<_> = ids
                .iter()
                .map(|id| json!({"id":id,"currency":"USD"}))
                .collect();
            (rows, ids.len(), 1)
        } else {
            assert_eq!(query["after"], "2026-09-30T23:59:59Z");
            assert_eq!(query["before"], binding().end);
            assert_eq!(query["dates_are_gmt"], "true");
            assert_eq!(query["dp"], "6");
            assert_eq!(query["orderby"], "id");
            assert_eq!(query["order"], "asc");
            assert_eq!(query["per_page"], "100");
            let page = query["page"].parse::<usize>().unwrap();
            let (total, make): (usize, fn(usize) -> Value) = match call.path {
                "/wp-json/wc/v3/orders" => {
                    assert_eq!(
                        query["_fields"],
                        "id,status,currency,date_created_gmt,total,refunds.id,refunds.total,line_items.id,line_items.product_id,line_items.variation_id,line_items.quantity,line_items.total,line_items.total_tax"
                    );
                    (self.orders, order)
                }
                "/wp-json/wc/v3/refunds" => {
                    assert_eq!(query["_fields"], "id,parent_id,date_created_gmt,amount");
                    (self.refunds, refund)
                }
                _ => panic!("unexpected path"),
            };
            let rows = ((page - 1) * 100 + 1..=(page * 100).min(total))
                .map(make)
                .collect();
            (rows, total, total.div_ceil(100))
        };
        let value = json!(rows);
        let raw = Zeroizing::new(serde_json::to_vec(&value).unwrap());
        let page = Page {
            json: provider_json::parse(&raw)?,
            raw,
            total: Some(total),
            pages: Some(pages),
        };
        Ok((self.mutate)(count, page))
    }
}
async fn credential() -> ReadKey {
    let raw=serde_json::to_vec(&json!({"consumer_key":format!("ck_{}","a".repeat(40)),"consumer_secret":format!("cs_{}","b".repeat(40))})).unwrap();
    let Credential::Commerce(key) = Crypto::default()
        .parse("woocommerce".into(), Zeroizing::new(raw))
        .await
        .unwrap()
    else {
        panic!("wrong credential");
    };
    key
}
#[tokio::test]
async fn complete_maximum_cohorts_and_product_groups_keep_exact_money_and_distinct_period_meaning()
{
    let key = credential().await;
    for (orders, refunds, calls) in [(0, 0, 4), (1, 1, 5), (500, 500, 22)] {
        let script = Script {
            orders,
            refunds,
            calls: Mutex::new(0),
            mutate: unchanged,
            fail: 0,
        };
        let workspace = commerce::fetch(&script, "https://shop.example/wordpress", &key, binding())
            .await
            .unwrap();
        assert_eq!(*script.calls.lock().unwrap(), calls);
        assert_eq!(workspace.orders.orders.len(), orders);
        assert_eq!(
            workspace.orders.grand_total_minor,
            (orders * 10000).to_string()
        );
        assert_eq!(workspace.orders.lifetime_refund_minor, "0");
        assert_eq!(workspace.refunds.amount_minor, (refunds * 100).to_string());
        if orders > 0 {
            let row = &workspace.products.products[0];
            assert_eq!(row.quantity, (orders * 2).to_string());
            assert_eq!(row.order_count, orders.to_string());
            assert_eq!(row.total_minor, (orders * 9000).to_string());
            assert_eq!(row.line_grand_minor, (orders * 10000).to_string());
        } else {
            assert!(workspace.products.products.is_empty());
        }
        let raw = serde_json::to_vec(&workspace).unwrap();
        let text = std::str::from_utf8(&raw).unwrap();
        for private in [
            "consumer_key",
            "consumer_secret",
            "shop.example",
            "customer",
            "billing",
            "payment",
            "reason",
            "ck_",
            "cs_",
        ] {
            assert!(!text.contains(private));
        }
        Workspace::decode(&raw, &binding()).unwrap();
        let mut expanded = serde_json::to_value(&workspace).unwrap();
        expanded["orders"]["customer_email"] = json!("personal@example.com");
        assert!(Workspace::decode(&serde_json::to_vec(&expanded).unwrap(), &binding()).is_err());
    }
}
#[tokio::test]
async fn request_failures_unstable_counts_parent_currencies_and_changed_heads_return_no_partial_result()
 {
    let key = credential().await;
    for fail in 1..=5 {
        let script = Script {
            orders: 1,
            refunds: 1,
            calls: Mutex::new(0),
            mutate: unchanged,
            fail,
        };
        assert!(
            commerce::fetch(&script, "https://shop.example/wordpress", &key, binding())
                .await
                .is_err()
        );
        assert_eq!(*script.calls.lock().unwrap(), fail);
    }
    for mutate in [
        (|count: usize, mut page: Page| {
            if count == 3 {
                page.json[0]["currency"] = json!("EUR");
            }
            page
        }) as fn(usize, Page) -> Page,
        |count, mut page| {
            if count == 4 {
                page.raw = Zeroizing::new(b"[]".to_vec());
            }
            page
        },
        |count, mut page| {
            if count == 1 {
                page.json[0]["currency"] = json!("EUR");
            }
            page
        },
        |count, mut page| {
            if count == 1 {
                page.json[0]["date_created_gmt"] = json!("2026-10-08T00:00:00");
            }
            page
        },
        |count, mut page| {
            if count == 1 {
                page.json[0]["line_items"][0]["quantity"] = json!(1.5);
            }
            page
        },
        |count, mut page| {
            if count == 1 {
                page.json[0]["billing"] = json!({"email":"private"});
            }
            page
        },
        |count, mut page| {
            if count == 2 {
                page.json[0]["parent_id"] = json!(20001);
            }
            page
        },
        |count, mut page| {
            if count == 3 {
                page.total = Some(2);
            }
            page
        },
        |count, mut page| {
            if count == 1 {
                page.pages = Some(2);
            }
            page
        },
    ] {
        let script = Script {
            orders: 1,
            refunds: 1,
            calls: Mutex::new(0),
            mutate,
            fail: 0,
        };
        assert!(
            commerce::fetch(&script, "https://shop.example/wordpress", &key, binding())
                .await
                .is_err()
        );
    }
    let script = Script {
        orders: 101,
        refunds: 0,
        calls: Mutex::new(0),
        mutate: |count, mut page| {
            if count == 2 {
                page.total = Some(102);
            }
            page
        },
        fail: 0,
    };
    assert!(
        commerce::fetch(&script, "https://shop.example/wordpress", &key, binding())
            .await
            .is_err()
    );
}
