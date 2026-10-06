use crate::{
    error::Error,
    integrations::{self, Disconnect},
    query::Query,
    testing::Fixture,
    validation,
    vault::Scope,
};

#[tokio::test]
async fn metadata_is_private_paginated_and_local_disable_never_claims_remote_success() {
    let f = Fixture::new().await;
    let mut ids = Vec::new();
    for (provider, account) in [
        ("ga4", "123456"),
        ("woocommerce", "https://synthetic.example.com"),
        ("meta_ads", "654321"),
    ] {
        let data = integrations::create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            provider.into(),
            account.into(),
        )
        .await
        .unwrap();
        assert_eq!(data.as_object().unwrap().len(), 7);
        assert!(data.get("provider_account_id").is_none());
        ids.push(data["id"].as_str().unwrap().to_owned());
    }
    assert!(matches!(
        integrations::create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            "ga4".into(),
            "123456".into()
        )
        .await,
        Err(Error::Conflict(_))
    ));
    let page = integrations::list(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        Query::parse("limit=1", &["limit", "cursor"]).unwrap(),
    )
    .await
    .unwrap();
    let cursor = page["page"]["next_cursor"].as_str().unwrap();
    let next = integrations::list(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        Query::parse(&format!("cursor={cursor}"), &["limit", "cursor"]).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(next["data"].as_array().unwrap().len(), 2);
    let scope = Scope {
        client: f.client.clone(),
        connection: ids[0].clone(),
        website: None,
    };
    let result = integrations::disconnect(
        &f.db,
        f.actor.clone(),
        scope.clone(),
        serde_json::from_value::<Disconnect>(serde_json::json!({"revision":"1","confirmed":true}))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(result["data"]["revision"], "2");
    assert_eq!(result["data"]["state"], "revocation_failed");
    assert_eq!(result["revocation"]["status"], "unavailable");
    assert_eq!(result["revocation"]["manual_action_required"], true);
    let conn = f.connection();
    let before: i64 = conn
        .query_row("SELECT count(*) FROM audit_events", [], |r| r.get(0))
        .unwrap();
    let input = || {
        serde_json::from_value::<Disconnect>(serde_json::json!({"revision":"2","confirmed":true}))
            .unwrap()
    };
    integrations::disconnect(&f.db, f.actor.clone(), scope.clone(), input())
        .await
        .unwrap();
    let after: i64 = conn
        .query_row("SELECT count(*) FROM audit_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
    conn.execute(
        "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='integrations.view'",
        [validation::now()],
    )
    .unwrap();
    assert!(matches!(
        integrations::read(&f.db, f.actor.clone(), scope.clone()).await,
        Err(Error::NotFound)
    ));
    assert!(matches!(
        integrations::disconnect(&f.db, f.actor.clone(), scope, input()).await,
        Err(Error::NotFound)
    ));
}
