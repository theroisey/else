use super::*;
use crate::{billing, query::Query, testing::Fixture, validation};
use serde_json::{Value, json};
fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    validation::json(&serde_json::to_vec(&v).unwrap()).unwrap()
}
fn query() -> Query {
    Query::parse("currency=EUR&from=2000-01-01&group=year", reporting::KEYS).unwrap()
}
#[tokio::test]
async fn exact_position_activity_aging_and_export_reconcile() {
    let f = Fixture::new().await;
    let collection=billing::create(&f.db,f.actor.clone(),f.client.clone(),input(json!({"description":"=Synthetic export formula","amount_minor":"70000","currency":"EUR","due_date":"2000-01-01"}))).await.unwrap();
    billing::record_payment(&f.db,f.actor.clone(),f.client.clone(),collection.id.clone(),input(json!({"command_id":validation::new_id(),"expected_revision":"1","amount_minor":"35000","currency":"EUR","paid_on":billing::today(),"method":"bank_transfer"}))).await.unwrap();
    let report = reporting::dashboard(&f.db, f.actor.clone(), query())
        .await
        .unwrap();
    assert_eq!(report["position"]["amount_minor"], "70000");
    assert_eq!(report["position"]["outstanding_minor"], "35000");
    assert_eq!(report["activity"]["net_minor"], "35000");
    assert_eq!(report["activity"]["unknown_minor"], "35000");
    assert_eq!(report["aging"][0]["amount_minor"], "35000");
    assert!(
        report["alerts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["rule"] == "over_90")
    );
    assert!(
        report["alerts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["rule"] == "unknown_collector")
    );
    assert_eq!(
        report["trends"].as_array().unwrap().last().unwrap()["cumulative_minor"],
        report["activity"]["net_minor"]
    );
    let csv = export::csv(&f.db, f.actor.clone(), query(), "receivables".into())
        .await
        .unwrap();
    assert!(csv["csv"].as_str().unwrap().contains("'=Synthetic"));
    let empty = reporting::dashboard(
        &f.db,
        f.actor,
        Query::parse("currency=USD", reporting::KEYS).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(empty["position"]["amount_minor"], "0");
}
#[tokio::test]
async fn expense_partial_payment_reversal_retry_and_retained_history() {
    let f = Fixture::new().await;
    let category = validation::new_id();
    expenses::category(
        &f.db,
        f.actor.clone(),
        input(json!({"id":category,"name":"Synthetic infrastructure"})),
    )
    .await
    .unwrap();
    let request = json!({"command_id":validation::new_id(),"category_id":category,"client_id":f.client,"title":"Synthetic hosting","vendor":"Synthetic vendor","description":"","currency":"EUR","amount_minor":"10000","expense_date":billing::today(),"due_date":"2000-01-01"});
    let created = expenses::create(&f.db, f.actor.clone(), input(request.clone()))
        .await
        .unwrap();
    let id = created["expense"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        expenses::create(&f.db, f.actor.clone(), input(request))
            .await
            .unwrap()["replayed"],
        true
    );
    let payment = json!({"command_id":validation::new_id(),"expected_revision":"1","payment_id":null,"amount_minor":"6000","occurred_on":billing::today(),"method":"bank_transfer","reason":""});
    let paid = expenses::event(&f.db, f.actor.clone(), id.clone(), input(payment.clone()))
        .await
        .unwrap();
    assert_eq!(paid["expense"]["outstanding_minor"], "4000");
    assert_eq!(
        expenses::event(&f.db, f.actor.clone(), id.clone(), input(payment))
            .await
            .unwrap()["replayed"],
        true
    );
    let reversal = json!({"command_id":validation::new_id(),"expected_revision":"2","payment_id":paid["event_id"],"amount_minor":"1000","occurred_on":billing::today(),"method":"bank_transfer","reason":"Synthetic correction"});
    let mut wrong_method = reversal.clone();
    wrong_method["method"] = json!("cash");
    assert!(
        expenses::event(&f.db, f.actor.clone(), id.clone(), input(wrong_method))
            .await
            .is_err()
    );
    let r = expenses::event(&f.db, f.actor.clone(), id.clone(), input(reversal))
        .await
        .unwrap();
    assert_eq!(r["expense"]["paid_minor"], "5000");
    assert_eq!(r["expense"]["revision"], "3");
    let report = reporting::dashboard(&f.db, f.actor.clone(), query())
        .await
        .unwrap();
    assert_eq!(report["expenses"]["activity"]["net_minor"], "5000");
    assert_eq!(report["expenses"]["position"]["overdue_minor"], "5000");
    let filtered = reporting::dashboard(
        &f.db,
        f.actor.clone(),
        Query::parse("currency=EUR&method=card", reporting::KEYS).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(filtered["expenses"]["activity"]["net_minor"], "5000");
    let matching = format!("currency=EUR&category_id={category}&status=open&q=hosting");
    let csv = export::csv(
        &f.db,
        f.actor.clone(),
        Query::parse(&matching, expenses::KEYS).unwrap(),
        "expenses".into(),
    )
    .await
    .unwrap();
    assert!(csv["csv"].as_str().unwrap().contains("Synthetic hosting"));
    let absent = export::csv(
        &f.db,
        f.actor.clone(),
        Query::parse("currency=EUR&status=paid", expenses::KEYS).unwrap(),
        "expenses".into(),
    )
    .await
    .unwrap();
    assert!(
        !absent["csv"]
            .as_str()
            .unwrap()
            .contains("Synthetic hosting")
    );

    assert!(
        expenses::cancel(
            &f.db,
            f.actor.clone(),
            id.clone(),
            input(json!({"command_id":validation::new_id(),"expected_revision":"3"}))
        )
        .await
        .is_err()
    );
    let a = input(
        json!({"command_id":validation::new_id(),"expected_revision":"3","payment_id":null,"amount_minor":"4000","occurred_on":billing::today(),"method":"card","reason":""}),
    );
    let b = input(
        json!({"command_id":validation::new_id(),"expected_revision":"3","payment_id":null,"amount_minor":"4000","occurred_on":billing::today(),"method":"card","reason":""}),
    );
    let (a, b) = tokio::join!(
        expenses::event(&f.db, f.actor.clone(), id.clone(), a),
        expenses::event(&f.db, f.actor.clone(), id.clone(), b)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(
        expenses::read(&f.db, f.actor.clone(), id).await.unwrap()["paid_minor"],
        "9000"
    );
    f.db.read(expenses::verify).await.unwrap();
}

#[tokio::test]
async fn company_permission_does_not_bypass_client_scope_and_revocation() {
    use rusqlite::params;
    let f = Fixture::new().await;
    let other = crate::clients::create(
        &f.db,
        f.actor.clone(),
        input(json!({"name":"Synthetic unrelated private brand"})),
    )
    .await
    .unwrap()
    .id;
    for (client, value) in [(&f.client, "100000"), (&other, "70000")] {
        billing::create(&f.db,f.actor.clone(),client.clone(),input(json!({"description":"Synthetic scoped debt","amount_minor":value,"currency":"EUR"}))).await.unwrap();
    }
    let user = validation::new_id();
    let role = validation::new_id();
    let uid = user.clone();
    let rid = role.clone();
    let brand = f.client.clone();
    f.db.write(move|tx|{let now=validation::now();tx.execute("INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?1,'financial-scope@example.com','Synthetic scoped reader','unused','active',?2,?2)",params![uid,now])?;tx.execute("INSERT INTO roles(id,role_key,display_name,created_at,updated_at) VALUES(?1,'financial-scope','Synthetic financial scope',?2,?2)",params![rid,now])?;
 for key in ["finance.read_company","billing.view"]{tx.execute("INSERT INTO role_permissions(id,role_id,permission_key,assigned_at) VALUES(?1,?2,?3,?4)",params![validation::new_id(),rid,key,now])?;}
 tx.execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,assigned_at) VALUES(?1,?2,?3,'global',?4)",params![validation::new_id(),uid,rid,now])?;
 tx.execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES(?1,?2,'00000000-0000-4000-8000-000000000006','client',?3,?4)",params![validation::new_id(),uid,brand,now])?;Ok(())}).await.unwrap();
    let actor = crate::security::Actor::operator(user).unwrap();
    let report = reporting::dashboard(&f.db, actor.clone(), query())
        .await
        .unwrap();
    assert_eq!(report["position"]["amount_minor"], "100000");
    assert!(report["expenses"].is_null());
    assert!(
        reporting::dashboard(
            &f.db,
            actor.clone(),
            Query::parse(&format!("client_id={other}"), reporting::KEYS).unwrap()
        )
        .await
        .is_err()
    );
    assert!(
        expenses::list(&f.db, actor.clone(), Query::default())
            .await
            .is_err()
    );
    let page = reporting::details(&f.db, actor.clone(), query(), "receivables".into())
        .await
        .unwrap();
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["data"][0]["client_id"], f.client);
    let scoped = f.client.clone();
    f.db.write(move |tx| {
        tx.execute(
            "UPDATE user_roles SET revoked_at=?1 WHERE client_id=?2",
            params![validation::now(), scoped],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let report = reporting::dashboard(&f.db, actor.clone(), query())
        .await
        .unwrap();
    assert_eq!(report["position"]["amount_minor"], "0");
    assert_eq!(report["activity"]["net_minor"], "0");
    let csv = export::csv(&f.db, actor, query(), "receivables".into())
        .await
        .unwrap();
    assert!(
        !csv["csv"]
            .as_str()
            .unwrap()
            .contains("Synthetic scoped debt")
    );
}
#[tokio::test]
async fn cancelled_reversed_undated_and_large_exact_obligations_remain_distinct() {
    let f = Fixture::new().await;
    let c=billing::create(&f.db,f.actor.clone(),f.client.clone(),input(json!({"description":"Synthetic cancellation","amount_minor":"70000","currency":"EUR","due_date":billing::today()}))).await.unwrap();
    let p=billing::record_payment(&f.db,f.actor.clone(),f.client.clone(),c.id.clone(),input(json!({"command_id":validation::new_id(),"expected_revision":"1","amount_minor":"35000","currency":"EUR","paid_on":billing::today(),"method":"cash"}))).await.unwrap();
    billing::reverse(&f.db,f.actor.clone(),f.client.clone(),c.id.clone(),p.payment_id.unwrap(),input(json!({"command_id":validation::new_id(),"expected_revision":"2","amount_minor":"5000","currency":"EUR","reversed_on":billing::today(),"reason":"Synthetic correction"}))).await.unwrap();
    billing::cancel(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        c.id,
        input(json!({"expected_revision":"3","confirm":true})),
    )
    .await
    .unwrap();
    for _ in 0..2 {
        billing::create(&f.db,f.actor.clone(),f.client.clone(),input(json!({"description":"Synthetic exact large debt","amount_minor":"9223372036854775807","currency":"EUR"}))).await.unwrap();
    }
    let d = reporting::dashboard(&f.db, f.actor.clone(), query())
        .await
        .unwrap();
    assert_eq!(d["position"]["amount_minor"], "18446744073709551614");
    assert_eq!(d["position"]["cancelled_amount_minor"], "70000");
    assert_eq!(d["position"]["cancelled_paid_minor"], "30000");
    assert_eq!(d["activity"]["gross_minor"], "35000");
    assert_eq!(d["activity"]["reversed_minor"], "5000");
    assert_eq!(d["activity"]["net_minor"], "30000");
    assert_eq!(d["position"]["overdue_minor"], "0");
    assert_eq!(d["aging"][0]["bucket"], "undated");
    let all = reporting::dashboard(
        &f.db,
        f.actor,
        Query::parse("from=0001-01-01&group=year", reporting::KEYS).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(all["previous"]["net_minor"], "0");
}
#[tokio::test]
async fn commercial_reporting_preserves_both_collectors_partial_allocation_and_internal_transfers()
{
    use crate::operations::commercial as c;
    let f = Fixture::new().await;
    let partner = validation::new_id();
    c::create_partner(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        input(json!({"id":partner,"name":"Synthetic financial partner"})),
    )
    .await
    .unwrap();
    for (collector, net, expected) in [("partner", "35000", "10000"), ("roise", "70000", "-50000")]
    {
        let agreement=c::create(&f.db,f.actor.clone(),f.client.clone(),input(json!({"command_id":validation::new_id(),"title":"Synthetic consulting source","service_type":"advertising_consulting","frequency":"once","start_date":billing::today(),"end_date":null,"due_offset_days":0,"timezone":"UTC","terms":{"amount_minor":"70000","currency":"EUR","roise_share_minor":"20000","partner_id":partner,"collector":collector,"allocation_policy":"proportional"}}))).await.unwrap();
        let period = c::generate(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            agreement["id"].as_str().unwrap().into(),
            input(json!({"billing_date":billing::today()})),
        )
        .await
        .unwrap();
        let id = period["id"].as_str().unwrap().to_owned();
        let period = c::period(&f.db, f.actor.clone(), f.client.clone(), id.clone())
            .await
            .unwrap();
        let collection = period["collection_id"].as_str().unwrap().to_owned();
        billing::record_payment(&f.db,f.actor.clone(),f.client.clone(),collection,input(json!({"command_id":validation::new_id(),"expected_revision":"1","amount_minor":net,"currency":"EUR","paid_on":billing::today(),"method":"bank_transfer","collector":collector}))).await.unwrap();
        let p = c::period(&f.db, f.actor.clone(), f.client.clone(), id.clone())
            .await
            .unwrap();
        assert_eq!(p["internal_remaining_to_roise_minor"], expected);
        if collector == "partner" {
            c::settle(&f.db,f.actor.clone(),f.client.clone(),id,input(json!({"command_id":validation::new_id(),"expected_revision":"1","direction":"partner_to_roise","amount_minor":"10000","currency":"EUR","settled_on":billing::today()}))).await.unwrap();
        }
    }
    let d = reporting::dashboard(&f.db, f.actor.clone(), query())
        .await
        .unwrap();
    assert_eq!(d["position"]["amount_minor"], "140000");
    assert_eq!(d["activity"]["net_minor"], "105000");
    assert_eq!(d["position"]["outstanding_minor"], "35000");
    assert_eq!(d["partners"][0]["balance_minor"], "-50000");
    assert_eq!(d["partners"][0]["payable_minor"], "50000");
    assert_eq!(d["settlements"]["incoming_minor"], "10000");
    assert_eq!(d["cashflow"][0]["net_minor"], "80000");
    let usd=billing::create(&f.db,f.actor.clone(),f.client.clone(),input(json!({"description":"Synthetic monthly software","amount_minor":"100000","currency":"USD"}))).await.unwrap();
    billing::record_payment(&f.db,f.actor.clone(),f.client.clone(),usd.id,input(json!({"command_id":validation::new_id(),"expected_revision":"1","amount_minor":"60000","currency":"USD","paid_on":billing::today(),"method":"card"}))).await.unwrap();
    let d = reporting::dashboard(
        &f.db,
        f.actor,
        Query::parse("currency=USD", reporting::KEYS).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(d["position"]["outstanding_minor"], "40000");
    assert!(d["partners"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn aging_buckets_are_exclusive_with_due_today_and_missing_dates() {
    let f = Fixture::new().await;
    let today = chrono::Utc::now().date_naive();
    for delta in [
        None,
        Some(-1),
        Some(0),
        Some(1),
        Some(7),
        Some(8),
        Some(15),
        Some(16),
        Some(30),
        Some(31),
        Some(60),
        Some(61),
        Some(90),
        Some(91),
    ] {
        let due = delta.map(|d| (today - chrono::Duration::days(d)).to_string());
        billing::create(&f.db,f.actor.clone(),f.client.clone(),input(json!({"description":"Synthetic aging boundary","amount_minor":"1","currency":"EUR","due_date":due}))).await.unwrap();
    }
    let report = reporting::dashboard(&f.db, f.actor, query()).await.unwrap();
    let rows = report["aging"].as_array().unwrap();
    assert_eq!(rows.len(), 9);
    assert_eq!(
        rows.iter()
            .map(|r| r["amount_minor"].as_str().unwrap().parse::<i128>().unwrap())
            .sum::<i128>(),
        14
    );
    assert_eq!(report["position"]["overdue_minor"], "11");
    assert_eq!(report["upcoming"][0]["amount_minor"], "2");
}

#[tokio::test]
async fn complete_reporting_refuses_oversized_sources_instead_of_partial_totals() {
    let f = Fixture::new().await;
    let actor = f.actor.user_id.clone();
    let client = f.client.clone();
    f.db.write(move |tx| {
        tx.execute("WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<50001) INSERT INTO collections(id,client_id,created_by,description,amount_minor,currency,currency_exponent,revision,created_at,updated_at) SELECT 'fa111111-1111-4111-8111-'||printf('%012d',i),?1,?2,'Synthetic bounded source',1,'JPY',0,1,?3,?3 FROM seq",rusqlite::params![client,actor,validation::now()])?;
        Ok(())
    }).await.unwrap();
    assert!(matches!(
        reporting::dashboard(
            &f.db,
            f.actor.clone(),
            Query::parse("currency=JPY", reporting::KEYS).unwrap()
        )
        .await,
        Err(crate::error::Error::Invalid("report_range_too_large"))
    ));
    assert!(matches!(
        reporting::details(
            &f.db,
            f.actor,
            Query::parse("currency=JPY", reporting::KEYS).unwrap(),
            "receivables".into()
        )
        .await,
        Err(crate::error::Error::Invalid("report_range_too_large"))
    ));
}
