use crate::{
    activity, audit_reader, billing, clients, error::Error, overview, query::Query, tasks,
    testing::Fixture, validation,
};
use serde_json::Value;

fn input<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn history_permissions_are_fresh_and_financial_storage_is_not_projected() {
    let f = Fixture::new().await;
    let collection=billing::create(&f.db,f.actor.clone(),f.client.clone(),input(serde_json::json!({"description":"Private invoice","amount_minor":"500","currency":"EUR"}))).await.unwrap();
    let history = audit_reader::list(
        &f.db,
        f.actor.clone(),
        Some(f.client.clone()),
        Query::default(),
    )
    .await
    .unwrap();
    let event = history["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["resource_id"] == collection.id)
        .unwrap();
    let detail = audit_reader::read(
        &f.db,
        f.actor.clone(),
        Some(f.client.clone()),
        event["id"].as_str().unwrap().into(),
    )
    .await
    .unwrap();
    assert_eq!(detail["after_state"]["revision"], "1");
    let safe = serde_json::to_string(&detail).unwrap();
    for secret in [
        "Private invoice",
        "amount_minor",
        "paid_minor",
        "currency",
        "billing_status",
    ] {
        assert!(!safe.contains(secret));
    }
    let activity = activity::list(&f.db, f.actor.clone(), f.client.clone(), Query::default())
        .await
        .unwrap();
    assert!(
        activity["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["resource_kind"] == "client")
    );
    assert!(activity["data"][0].get("actor_user_id").is_none());
    let conn = f.connection();
    let before: i64 = conn
        .query_row("SELECT count(*) FROM audit_events", [], |r| r.get(0))
        .unwrap();
    conn.execute(
        "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='clients.view'",
        [validation::now()],
    )
    .unwrap();
    assert!(matches!(
        audit_reader::list(
            &f.db,
            f.actor.clone(),
            Some(f.client.clone()),
            Query::default()
        )
        .await,
        Err(Error::NotFound)
    ));
    let global = audit_reader::list(&f.db, f.actor.clone(), None, Query::default())
        .await
        .unwrap();
    assert!(
        global["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["client_id"].is_null())
    );
    assert!(matches!(
        activity::list(&f.db, f.actor.clone(), f.client.clone(), Query::default()).await,
        Err(Error::NotFound)
    ));
    assert!(matches!(
        overview::read(&f.db, f.actor.clone(), f.client.clone()).await,
        Err(Error::NotFound)
    ));
    let after: i64 = conn
        .query_row("SELECT count(*) FROM audit_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn audit_cursors_bind_filters_scope_and_order_and_allow_changing_page_size() {
    let f = Fixture::new().await;
    for index in 0..3 {
        clients::create(
            &f.db,
            f.actor.clone(),
            input(serde_json::json!({"name":format!("Synthetic {index}")})),
        )
        .await
        .unwrap();
    }
    let query = Query::parse("limit=1&event_type=client.created", audit_reader::FILTERS).unwrap();
    let first = audit_reader::list(&f.db, f.actor.clone(), None, query)
        .await
        .unwrap();
    let cursor = first["page"]["next_cursor"].as_str().unwrap();
    let query = Query::parse(
        &format!("limit=100&event_type=client.created&cursor={cursor}"),
        audit_reader::FILTERS,
    )
    .unwrap();
    let second = audit_reader::list(&f.db, f.actor.clone(), None, query.clone())
        .await
        .unwrap();
    assert_eq!(second["data"].as_array().unwrap().len(), 3);
    assert!(
        second["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != first["data"][0]["id"])
    );
    assert!(second["page"]["next_cursor"].is_null());
    assert!(matches!(
        audit_reader::list(&f.db, f.actor.clone(), Some(f.client.clone()), query).await,
        Err(Error::Invalid(_))
    ));
    let query = Query::parse(
        &format!("event_type=task.created&cursor={cursor}"),
        audit_reader::FILTERS,
    )
    .unwrap();
    assert!(matches!(
        audit_reader::list(&f.db, f.actor.clone(), None, query).await,
        Err(Error::Invalid(_))
    ));
}

#[tokio::test]
async fn overview_has_bounded_ordered_queues_and_omits_unauthorized_sections() {
    let f = Fixture::new().await;
    for index in 0..7 {
        tasks::create(&f.db,f.actor.clone(),f.client.clone(),input(serde_json::json!({"title":format!("Synthetic attention {index}"),"due_at":format!("2020-01-0{}T00:00:00Z",index+1)}))).await.unwrap();
    }
    let view = overview::read(&f.db, f.actor.clone(), f.client.clone())
        .await
        .unwrap();
    assert_eq!(
        view["tasks"]["overdue"]["items"].as_array().unwrap().len(),
        5
    );
    assert_eq!(view["tasks"]["overdue"]["has_more"], true);
    assert_eq!(
        view["tasks"]["overdue"]["items"][0]["due_at"],
        "2020-01-01T00:00:00.000000Z"
    );
    let as_of = chrono::DateTime::parse_from_rfc3339(view["as_of"].as_str().unwrap()).unwrap();
    let horizon =
        chrono::DateTime::parse_from_rfc3339(view["horizon_end"].as_str().unwrap()).unwrap();
    assert_eq!((horizon - as_of).num_hours(), 168);
    f.connection().execute("UPDATE role_permissions SET revoked_at=?1 WHERE permission_key IN ('tasks.view','billing.view','reminders.view')",[validation::now()]).unwrap();
    let view = overview::read(&f.db, f.actor.clone(), f.client.clone())
        .await
        .unwrap();
    for section in ["tasks", "finance", "reminders"] {
        assert!(view.get(section).is_none());
    }
    assert_eq!(view["activity"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(view["activity"]["has_more"], false);
    assert_eq!(view["activity"]["items"][0]["summary"], "Client created.");
}

#[test]
fn chronological_boundaries_reject_altered_encoding_and_invalid_instants() {
    let id = "00000000-0000-4000-8000-000000000001";
    let raw = crate::history_cursor::encode("scope", "2026-10-06T12:00:00.123400Z", id).unwrap();
    let cursor = crate::history_cursor::decode("scope", Some(&raw))
        .unwrap()
        .unwrap();
    assert_eq!(cursor.time, "2026-10-06T12:00:00.123400Z");
    assert!(crate::history_cursor::decode("wrong", Some(&raw)).is_err());
    assert!(crate::history_cursor::decode("scope", Some(&format!("{raw}="))).is_err());
    for time in [
        "2026-10-06T12:00:00+00:00",
        "2026-10-06T12:00:00.1234560Z",
        "2016-12-31T23:59:60Z",
        "0000-01-01T00:00:00Z",
    ] {
        assert!(crate::history_cursor::utc(time).is_err(), "{time}");
    }
}
