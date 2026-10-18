use super::{access, management, oauth};
use crate::{audit, config::Config, error::Error, query::Query, security, testing::Fixture};
use oauth2::{PkceCodeChallenge, PkceCodeVerifier};
use serde_json::{Value, json};

fn config(f: &Fixture) -> Config {
    Config {
        address: "127.0.0.1:8080".parse().unwrap(),
        database: f.directory.path().join("else.sqlite3"),
        frontend: f.directory.path().join("frontend"),
        origin: "http://127.0.0.1:8080".into(),
        secure_cookie: false,
        key_file: f.directory.path().join("key.json"),
        key_provision: true,
        key_restored: false,
    }
}
fn query(value: Value) -> Query {
    Query(
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
            .collect(),
    )
}
async fn application(f: &Fixture) -> String {
    let status = management::status(&f.db, &config(f), f.actor.clone())
        .await
        .unwrap();
    management::settings(
        &f.db,
        f.actor.clone(),
        management::Settings {
            enabled: true,
            expected_revision: status["revision"].as_str().unwrap().into(),
        },
    )
    .await
    .unwrap();
    management::register(
        &f.db,
        f.actor.clone(),
        management::Application {
            name: "Synthetic MCP client".into(),
            redirect_uris: vec!["http://127.0.0.1:9876/callback".into()],
            origins: vec!["http://127.0.0.1:9876".into()],
        },
    )
    .await
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
async fn code(f: &Fixture, app: &str, scope: &str, client: Option<String>) -> String {
    let config = config(f);
    let verifier = PkceCodeVerifier::new("v".repeat(64));
    let challenge = PkceCodeChallenge::from_code_verifier_sha256(&verifier);
    let url=oauth::start(&f.db,&config,query(json!({"response_type":"code","client_id":app,"redirect_uri":"http://127.0.0.1:9876/callback","resource":oauth::resource(&config),"scope":scope,"state":"synthetic-oauth-state","code_challenge_method":"S256","code_challenge":challenge.as_str()}))).await.unwrap();
    let id = url.rsplit('/').next().unwrap().to_owned();
    let consent = oauth::consent(
        &f.db,
        &config,
        f.actor.clone(),
        id,
        oauth::Consent {
            approve: true,
            scopes: scope.split(' ').map(str::to_owned).collect(),
            client_id: client,
        },
    )
    .await
    .unwrap();
    let redirect = url::Url::parse(consent["redirect_url"].as_str().unwrap()).unwrap();
    assert!(
        redirect
            .query_pairs()
            .any(|(k, v)| k == "state" && v == "synthetic-oauth-state")
    );
    assert!(
        redirect
            .query_pairs()
            .any(|(k, v)| k == "iss" && v == config.origin)
    );
    redirect
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .into_owned()
}
async fn exchange(
    f: &Fixture,
    app: &str,
    code: &str,
    verifier: &str,
) -> crate::error::Result<Value> {
    oauth::token(&f.db,&config(f),query(json!({"grant_type":"authorization_code","client_id":app,"resource":oauth::resource(&config(f)),"redirect_uri":"http://127.0.0.1:9876/callback","code":code,"code_verifier":verifier}))).await
}

#[tokio::test]
async fn oauth_pkce_audience_current_grants_and_refresh_replay_are_enforced() {
    let f = Fixture::new().await;
    let app = application(&f).await;
    let code = code(&f, &app, "clients:read tasks:read", Some(f.client.clone())).await;
    assert!(exchange(&f, &app, &code, &"x".repeat(64)).await.is_err());
    let tokens = exchange(&f, &app, &code, &"v".repeat(64)).await.unwrap();
    let access = tokens["access_token"].as_str().unwrap();
    assert!(
        access::authenticate(
            &f.db,
            access,
            "https://another.example/mcp".into(),
            audit::request_id()
        )
        .await
        .is_err()
    );
    let actor = access::authenticate(
        &f.db,
        access,
        oauth::resource(&config(&f)),
        audit::request_id(),
    )
    .await
    .unwrap();
    let actor_read = actor.clone();
    let brand = f.client.clone();
    f.db.read(move |tx| {
        security::require(tx, &actor_read, "clients.view", Some(&brand))?;
        assert!(!security::allowed_actor(
            tx,
            &actor_read,
            "billing.view",
            Some(&brand)
        )?);
        assert!(!security::allowed_actor(
            tx,
            &actor_read,
            "clients.update",
            Some(&brand)
        )?);
        assert!(!security::allowed_actor(
            tx,
            &actor_read,
            "users.manage",
            None
        )?);
        assert!(!security::allowed_actor(
            tx,
            &actor_read,
            "clients.view",
            Some("99999999-9999-4999-8999-999999999999")
        )?);
        Ok(())
    })
    .await
    .unwrap();
    let refresh = tokens["refresh_token"].as_str().unwrap().to_owned();
    let original_expiry =
        f.db.read(|tx| {
            tx.query_row("SELECT expires_at FROM mcp_grants LIMIT 1", [], |r| {
                r.get::<_, String>(0)
            })
            .map_err(Error::from)
        })
        .await
        .unwrap();
    let q = query(
        json!({"grant_type":"refresh_token","client_id":app,"resource":oauth::resource(&config(&f)),"refresh_token":refresh,"scope":"clients:read"}),
    );
    let rotated = oauth::token(&f.db, &config(&f), q.clone()).await.unwrap();
    assert!(rotated["scope"] == "clients:read");
    let active = access::authenticate(
        &f.db,
        rotated["access_token"].as_str().unwrap(),
        oauth::resource(&config(&f)),
        audit::request_id(),
    )
    .await
    .unwrap();
    assert!(oauth::token(&f.db, &config(&f), q).await.is_err());
    assert!(
        f.db.read(move |tx| security::fresh(tx, &active))
            .await
            .is_err()
    );
    assert!(
        f.db.read(move |tx| security::fresh(tx, &actor))
            .await
            .is_err()
    );
    let after =
        f.db.read(|tx| {
            tx.query_row("SELECT expires_at FROM mcp_grants LIMIT 1", [], |r| {
                r.get::<_, String>(0)
            })
            .map_err(Error::from)
        })
        .await
        .unwrap();
    assert!(after == original_expiry);
}

#[tokio::test]
async fn unsafe_redirects_issuer_changes_revocation_and_feature_disable_fail_closed() {
    let f = Fixture::new().await;
    let app = application(&f).await;
    for uri in [
        "https://allowed.example/callback#fragment",
        "http://private.example/callback",
        "https://user:secret@example.com/callback",
        "https://valid.example/callback?code=injected",
    ] {
        assert!(oauth::redirect(uri).is_err());
    }
    let code = code(&f, &app, "clients:read", None).await;
    let tokens = exchange(&f, &app, &code, &"v".repeat(64)).await.unwrap();
    let raw = tokens["access_token"].as_str().unwrap();
    let actor = access::authenticate(
        &f.db,
        raw,
        oauth::resource(&config(&f)),
        audit::request_id(),
    )
    .await
    .unwrap();
    let current = actor.clone();
    let admin = f.actor.user_id.clone();
    f.db.write(move|tx|{tx.execute("UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='clients.view' AND role_id IN(SELECT role_id FROM user_roles WHERE user_id=?2)",rusqlite::params![crate::validation::now(),admin])?;Ok(())}).await.unwrap();
    let client = f.client.clone();
    assert!(
        f.db.read(move |tx| security::require(tx, &current, "clients.view", Some(&client)))
            .await
            .is_err()
    );
    let status = management::status(&f.db, &config(&f), f.actor.clone())
        .await
        .unwrap();
    management::settings(
        &f.db,
        f.actor.clone(),
        management::Settings {
            enabled: false,
            expected_revision: status["revision"].as_str().unwrap().into(),
        },
    )
    .await
    .unwrap();
    assert!(
        f.db.read(move |tx| security::fresh(tx, &actor))
            .await
            .is_err()
    );
    assert!(
        access::authenticate(
            &f.db,
            raw,
            oauth::resource(&config(&f)),
            audit::request_id()
        )
        .await
        .is_err()
    );
}

fn api(f: &Fixture) -> crate::api::Api {
    use base64::Engine;
    let ring=crate::credentials::Keyring::parse(&serde_json::to_vec(&json!({"active_key_id":"synthetic_mcp","keys":[{"id":"synthetic_mcp","key_base64":base64::engine::general_purpose::STANDARD.encode([47u8;32])}]})).unwrap()).unwrap();
    let vault = crate::vault::Vault::new(f.db.clone(), ring.clone());
    crate::api::Api {
        config: config(f),
        db: f.db.clone(),
        auth: f.auth.clone(),
        vault: vault.clone(),
        synchronization: crate::synchronization::Synchronization::new(f.db.clone(), vault, ring),
        report_cache: Default::default(),
    }
}
async fn delegated(
    f: &Fixture,
    scope: &str,
    client: Option<String>,
) -> (crate::security::Actor, String) {
    let app = application(f).await;
    let code = code(f, &app, scope, client).await;
    let tokens = exchange(f, &app, &code, &"v".repeat(64)).await.unwrap();
    let token = tokens["access_token"].as_str().unwrap().to_owned();
    let actor = access::authenticate(
        &f.db,
        &token,
        oauth::resource(&config(f)),
        audit::request_id(),
    )
    .await
    .unwrap();
    (actor, token)
}
fn rpc(token: &str, method: &str, params: Value, modern: bool) -> crate::api::Request {
    let mut headers = http::HeaderMap::new();
    headers.insert("host", "127.0.0.1:8080".parse().unwrap());
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.insert(
        "accept",
        "application/json, text/event-stream".parse().unwrap(),
    );
    let mut params = params;
    if modern {
        headers.insert(
            "mcp-protocol-version",
            super::protocol::MODERN.parse().unwrap(),
        );
        headers.insert("mcp-method", method.parse().unwrap());
        if let Some(name) = params["name"].as_str().or(params["uri"].as_str()) {
            headers.insert("mcp-name", name.parse().unwrap());
        }
        params["_meta"] = json!({"io.modelcontextprotocol/protocolVersion":super::protocol::MODERN,"io.modelcontextprotocol/clientCapabilities":{}});
    } else if method != "initialize" {
        headers.insert(
            "mcp-protocol-version",
            super::protocol::LEGACY.parse().unwrap(),
        );
    }
    crate::api::Request {
        upload_admission: None,
        method: http::Method::POST,
        path: "/mcp".into(),
        query: String::new(),
        query_present: false,
        headers,
        body: serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .unwrap(),
        peer: "synthetic-test".into(),
        request_id: audit::request_id(),
    }
}
fn body(r: &http::Response<bytes::Bytes>) -> Value {
    serde_json::from_slice(r.body()).unwrap()
}
#[tokio::test]
async fn current_and_legacy_transport_discovery_names_metadata_and_errors() {
    let f = Fixture::new().await;
    let (actor, token) = delegated(&f, &access::SCOPES.join(" "), None).await;
    let api = api(&f);
    let bridge = super::transport::Bridge::default();
    let r = bridge
        .handle(&api, rpc(&token, "server/discover", json!({}), true))
        .await;
    assert_eq!(r.status(), 200);
    assert_eq!(body(&r)["result"]["resultType"], "complete");
    assert_eq!(body(&r)["result"]["cacheScope"], "private");
    let init=bridge.handle(&api,rpc(&token,"initialize",json!({"protocolVersion":super::protocol::LEGACY,"clientInfo":{"name":"synthetic-client","version":"1"},"capabilities":{}}),false)).await;
    assert_eq!(init.status(), 200);
    assert_eq!(
        body(&init)["result"]["protocolVersion"],
        super::protocol::LEGACY
    );
    assert!(body(&init)["result"].get("resultType").is_none());
    let mut listed = vec![];
    let mut params = json!({});
    loop {
        let r = bridge
            .handle(&api, rpc(&token, "tools/list", params, true))
            .await;
        assert_eq!(r.status(), 200);
        let v = body(&r);
        listed.extend(v["result"]["tools"].as_array().unwrap().clone());
        if let Some(cursor) = v["result"]["nextCursor"].as_str() {
            params = json!({"cursor":cursor});
        } else {
            break;
        }
    }
    assert_eq!(listed.len(), super::registry::definitions().len());
    assert!(listed.len() > 100);
    assert!(
        listed
            .iter()
            .all(|t| t["inputSchema"]["additionalProperties"] == false)
    );
    let tool = bridge
        .handle(
            &api,
            rpc(
                &token,
                "tools/call",
                json!({"name":"else_clients_get","arguments":{"client_id":f.client}}),
                true,
            ),
        )
        .await;
    assert_eq!(tool.status(), 200);
    assert_eq!(
        body(&tool)["result"]["structuredContent"]["data"]["id"],
        f.client
    );
    let resource = bridge
        .handle(
            &api,
            rpc(
                &token,
                "resources/read",
                json!({"uri":format!("else://clients/{}",f.client)}),
                true,
            ),
        )
        .await;
    assert_eq!(resource.status(), 200);
    assert_eq!(
        body(&resource)["result"]["contents"][0]["mimeType"],
        "application/json"
    );
    let prompt = bridge
        .handle(
            &api,
            rpc(
                &token,
                "prompts/get",
                json!({"name":"client_brief","arguments":{"client_id":f.client}}),
                true,
            ),
        )
        .await;
    assert_eq!(prompt.status(), 200);
    assert!(
        body(&prompt)["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("untrusted")
    );
    let mut mismatch = rpc(&token, "tools/call", json!({"name":"else_identity"}), true);
    mismatch
        .headers
        .insert("mcp-name", "else_clients_get".parse().unwrap());
    let r = bridge.handle(&api, mismatch).await;
    assert_eq!(r.status(), 400);
    assert_eq!(body(&r)["error"]["code"], -32020);
    let unknown = bridge
        .handle(&api, rpc(&token, "not/implemented", json!({}), true))
        .await;
    assert_eq!(unknown.status(), 404);
    assert_eq!(body(&unknown)["error"]["code"], -32601);
    let mut wrong = rpc(&token, "ping", json!({}), true);
    wrong
        .headers
        .insert("mcp-protocol-version", "1900-01-01".parse().unwrap());
    let r = bridge.handle(&api, wrong).await;
    assert_eq!(body(&r)["error"]["code"], -32022);
    let mut cookie_only = rpc(&token, "ping", json!({}), true);
    cookie_only.headers.remove("authorization");
    cookie_only
        .headers
        .insert("cookie", "else_session=synthetic".parse().unwrap());
    let r = bridge.handle(&api, cookie_only).await;
    assert_eq!(r.status(), 401);
    assert!(r.headers().contains_key("www-authenticate"));
    let mut unsafe_origin = rpc(&token, "ping", json!({}), true);
    unsafe_origin
        .headers
        .insert("origin", "https://unregistered.example".parse().unwrap());
    assert_eq!(bridge.handle(&api, unsafe_origin).await.status(), 403);
    let mut duplicate = rpc(&token, "ping", json!({}), true);
    duplicate.body = br#"{"jsonrpc":"2.0","id":1,"method":"ping","method":"tools/call"}"#.to_vec();
    assert_eq!(
        body(&bridge.handle(&api, duplicate).await)["error"]["code"],
        -32700
    );
    assert!(super::registry::list(&f.db, actor).await.unwrap().len() > 100);
}
#[tokio::test]
async fn scoped_aggregates_resources_search_and_current_record_permissions_do_not_leak() {
    let f = Fixture::new().await;
    let other = crate::clients::create(
        &f.db,
        f.actor.clone(),
        crate::validation::json(br#"{"name":"Unrelated private brand"}"#).unwrap(),
    )
    .await
    .unwrap()
    .id;
    let (actor, _) = delegated(&f, "clients:read", Some(f.client.clone())).await;
    let api = api(&f);
    let page = super::registry::call(&api, actor.clone(), "else_clients_list", json!({}))
        .await
        .unwrap();
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["data"][0]["id"], f.client);
    assert!(
        super::registry::call(
            &api,
            actor.clone(),
            "else_clients_get",
            json!({"client_id":other})
        )
        .await
        .is_err()
    );
    assert!(
        super::context::read(&api, actor.clone(), &format!("else://clients/{other}"))
            .await
            .is_err()
    );
    let overview = super::registry::call(
        &api,
        actor.clone(),
        "else_clients_overview",
        json!({"client_id":f.client}),
    )
    .await
    .unwrap();
    assert!(overview.get("finance").is_none());
    assert!(overview.get("tasks").is_none());
    assert!(overview.get("operations").is_none());
    let today = super::registry::call(&api, actor.clone(), "else_today", json!({}))
        .await
        .unwrap();
    assert!(today.get("finance").is_none());
    assert!(today.get("internal_finance").is_none());
    assert!(today.get("team_members").is_none());
    assert_eq!(today["brands"]["items"].as_array().unwrap().len(), 1);
    let names = super::registry::list(&f.db, actor.clone()).await.unwrap();
    assert!(
        names
            .iter()
            .all(|v| !v["name"].as_str().unwrap().contains("finance")
                && !v["name"].as_str().unwrap().contains("collections"))
    );
    assert!(
        super::registry::call(
            &api,
            actor,
            "else_collections_list",
            json!({"client_id":f.client})
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn standard_commands_are_atomic_under_concurrent_retries_and_payload_changes_conflict() {
    let f = Fixture::new().await;
    let (actor, _) = delegated(
        &f,
        "clients:read tasks:read tasks:write",
        Some(f.client.clone()),
    )
    .await;
    let api = api(&f);
    let command = crate::validation::new_id();
    let args = json!({"client_id":f.client,"command_id":command,"input":{"title":"One retained MCP task"}});
    let (a, b, c) = tokio::join!(
        super::registry::call(&api, actor.clone(), "else_tasks_create", args.clone()),
        super::registry::call(&api, actor.clone(), "else_tasks_create", args.clone()),
        super::registry::call(&api, actor.clone(), "else_tasks_create", args.clone())
    );
    let a = a.unwrap();
    assert_eq!(a, b.unwrap());
    assert_eq!(a, c.unwrap());
    assert_eq!(a["status"], "committed");
    assert_eq!(
        super::registry::call(&api, actor.clone(), "else_tasks_create", args.clone())
            .await
            .unwrap(),
        a
    );
    let mut changed = args;
    changed["input"]["title"] = json!("Different");
    assert!(matches!(
        super::registry::call(&api, actor, "else_tasks_create", changed).await,
        Err(Error::Conflict("command_conflict"))
    ));
    let count =
        f.db.read(|tx| {
            Ok(tx.query_row(
                "SELECT count(*) FROM tasks WHERE title='One retained MCP task'",
                [],
                |r| r.get::<_, i64>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(count, 1);
    let count=f.db.read(|tx|Ok(tx.query_row("SELECT count(*) FROM audit_events WHERE json_extract(metadata,'$.source')='mcp' AND resource_kind='task'",[],|r|r.get::<_,i64>(0))?)).await.unwrap();
    assert_eq!(count, 1);
}
#[tokio::test]
async fn malformed_intents_and_missing_commit_proofs_cannot_change_business_data() {
    let f = Fixture::new().await;
    let (actor, _) = delegated(&f, &access::SCOPES.join(" "), None).await;
    let api = api(&f);
    // Exercise every write's advertised envelope, including high-impact intents.
    for d in super::registry::definitions()
        .iter()
        .filter(|d| !d.kind.is_empty())
    {
        let mut args = json!({});
        for field in d.fields {
            args[*field] = match *field {
                "input" => json!([]),
                "query" | "approval_id" | "currency" => continue,
                "client_id" => json!(f.client),
                _ => json!(crate::validation::new_id()),
            };
        }
        assert!(
            super::registry::call(&api, actor.clone(), d.name, args)
                .await
                .is_err(),
            "{} accepted a malformed intent",
            d.name
        );
    }
    let faulty = actor.with_command(access::Command {
        id: crate::validation::new_id(),
        tool: "else_tasks_create".into(),
        digest: "0".repeat(64),
        kind: "incorrect_catalog_kind",
        approval_id: None,
        high_impact: false,
    });
    let db = f.db.for_mcp_write(&faulty);
    assert!(
        crate::tasks::create(
            &db,
            faulty,
            f.client.clone(),
            crate::validation::json(br#"{"title":"Must roll back without proof"}"#).unwrap()
        )
        .await
        .is_err()
    );
    let counts =
        f.db.read(|tx| {
            Ok((
                tx.query_row("SELECT count(*) FROM tasks", [], |r| r.get::<_, i64>(0))?,
                tx.query_row("SELECT count(*) FROM mcp_approvals", [], |r| {
                    r.get::<_, i64>(0)
                })?,
                tx.query_row("SELECT count(*) FROM mcp_commands", [], |r| {
                    r.get::<_, i64>(0)
                })?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(counts, (0, 0, 0));
}

#[tokio::test]
async fn financial_review_payload_is_hidden_after_current_financial_authority_is_revoked() {
    let f = Fixture::new().await;
    let (actor, _) = delegated(
        &f,
        "clients:read finance:write finance:read",
        Some(f.client.clone()),
    )
    .await;
    let api = api(&f);
    let pending = super::registry::call(&api, actor, "else_collections_create", json!({"client_id":f.client,"command_id":crate::validation::new_id(),"input":{"description":"Private commercial terms","amount_minor":"70000","currency":"EUR"}})).await.unwrap();
    let id = pending["approval_id"].as_str().unwrap().to_owned();
    let review = super::commands::inspect(&f.db, f.actor.clone(), id.clone())
        .await
        .unwrap();
    f.db.write(|tx| { tx.execute("UPDATE role_permissions SET revoked_at=?1 WHERE permission_key IN ('billing.view','billing.manage')", [crate::validation::now()])?; Ok(()) }).await.unwrap();
    assert!(matches!(
        super::commands::inspect(&f.db, f.actor.clone(), id.clone()).await,
        Err(Error::Denied)
    ));
    assert!(matches!(
        super::commands::decide(
            &f.db,
            f.actor.clone(),
            id,
            super::commands::Decision {
                approve: true,
                argument_digest: review["argument_digest"].as_str().unwrap().into()
            }
        )
        .await,
        Err(Error::Denied)
    ));
}

#[tokio::test]
async fn separate_employee_and_developer_mcp_identities_preserve_delivery_reviews_and_current_scope()
 {
    let mut f = Fixture::new().await;
    let app = application(&f).await;
    let owner = f.actor.clone();
    let (developer, _) = delegated(
        &f,
        "clients:read requests:read requests:develop tasks:read tasks:write",
        Some(f.client.clone()),
    )
    .await;
    let user = crate::administration::create_user(&f.auth, owner.clone(), crate::validation::json(br#"{"email":"mcp-employee@example.com","display_name":"Synthetic advertising employee","password":"synthetic-password"}"#).unwrap()).await.unwrap();
    f.connection().execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES (?1,?2,'00000000-0000-4000-8000-000000000006','client',?3,?4)", rusqlite::params![crate::validation::new_id(), user.id, f.client, crate::validation::now()]).unwrap();
    f.actor = f
        .auth
        .login(
            crate::auth::Login {
                email: "mcp-employee@example.com".into(),
                password: "synthetic-password".into(),
            },
            audit::request_id(),
        )
        .await
        .unwrap()
        .session
        .actor;
    let code = code(
        &f,
        &app,
        "clients:read requests:read requests:write requests:review",
        Some(f.client.clone()),
    )
    .await;
    let tokens = exchange(&f, &app, &code, &"v".repeat(64)).await.unwrap();
    let employee = access::authenticate(
        &f.db,
        tokens["access_token"].as_str().unwrap(),
        oauth::resource(&config(&f)),
        audit::request_id(),
    )
    .await
    .unwrap();
    let api = api(&f);
    let created = super::registry::call(&api, employee.clone(), "else_requests_create", json!({"client_id":f.client,"command_id":crate::validation::new_id(),"input":{"brand_wide":true,"title":"Synthetic mobile request","description":"Mobile button overflows","category":"bug","priority":"normal"}})).await.unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    for (revision, (name, actor, reason)) in (1..).zip([
        ("else_requests_accept", &developer, ""),
        ("else_requests_start", &developer, ""),
        (
            "else_requests_deliver",
            &developer,
            "Corrected mobile layout",
        ),
        (
            "else_requests_revise",
            &employee,
            "Narrow viewport still overflows",
        ),
        ("else_requests_start", &developer, ""),
        (
            "else_requests_deliver",
            &developer,
            "Corrected narrow viewport",
        ),
        ("else_requests_approve", &employee, ""),
    ]) {
        let mut input = json!({"expected_revision":revision.to_string(),"reason":reason});
        if name == "else_requests_accept" {
            input["assignee_id"] = json!(owner.user_id);
        }
        if matches!(name, "else_requests_approve" | "else_requests_revise") {
            let record = crate::operations::requests::read(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                id.clone(),
            )
            .await
            .unwrap();
            input["delivery_id"] = record["deliveries"][0]["id"].clone();
        }
        let result = super::registry::call(&api, actor.clone(), name, json!({"client_id":f.client,"id":id,"command_id":crate::validation::new_id(),"input":input})).await.unwrap();
        assert_eq!(result["status"], "committed", "{name}");
    }
    let record = super::registry::call(
        &api,
        employee.clone(),
        "else_requests_get",
        json!({"client_id":f.client,"id":id}),
    )
    .await
    .unwrap();
    assert_eq!(record["status"], "approved");
    assert_eq!(record["deliveries"].as_array().unwrap().len(), 2);
    assert_eq!(record["created_by"], user.id);
    assert!(
        super::registry::call(
            &api,
            employee.clone(),
            "else_finance_summary",
            json!({"client_id":f.client})
        )
        .await
        .is_err()
    );
    f.db.write(move |tx| {
        tx.execute(
            "UPDATE user_roles SET revoked_at=?1 WHERE user_id=?2 AND revoked_at IS NULL",
            rusqlite::params![crate::validation::now(), user.id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        super::registry::call(
            &api,
            employee,
            "else_requests_get",
            json!({"client_id":f.client,"id":id})
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn financial_mutation_requires_exact_browser_approval_and_retains_a_single_payment() {
    let f = Fixture::new().await;
    let (actor, _) = delegated(
        &f,
        "clients:read finance:read finance:write",
        Some(f.client.clone()),
    )
    .await;
    let api = api(&f);
    let collection = crate::billing::create(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        crate::validation::json(
            br#"{"description":"Synthetic maintenance","amount_minor":"100000","currency":"USD"}"#,
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let args = json!({"client_id":f.client,"id":collection.id,"command_id":crate::validation::new_id(),"input":{"expected_revision":"1","amount_minor":"60000","currency":"USD","paid_on":"2020-01-01","method":"bank_transfer","reference":"Synthetic private reference"}});
    let pending = super::registry::call(
        &api,
        actor.clone(),
        "else_collections_record_payment",
        args.clone(),
    )
    .await
    .unwrap();
    assert_eq!(pending["status"], "approval_required");
    let id = pending["approval_id"].as_str().unwrap().to_owned();
    let position = crate::billing::read(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        collection.id.clone(),
    )
    .await
    .unwrap();
    assert_eq!(position["paid_minor"], "0");
    let review = super::commands::inspect(&f.db, f.actor.clone(), id.clone())
        .await
        .unwrap();
    assert!(
        super::commands::decide(
            &f.db,
            actor.clone(),
            id.clone(),
            super::commands::Decision {
                approve: true,
                argument_digest: review["argument_digest"].as_str().unwrap().into()
            }
        )
        .await
        .is_err()
    );
    assert!(
        super::commands::decide(
            &f.db,
            f.actor.clone(),
            id.clone(),
            super::commands::Decision {
                approve: true,
                argument_digest: "0".repeat(64)
            }
        )
        .await
        .is_err()
    );
    super::commands::decide(
        &f.db,
        f.actor.clone(),
        id.clone(),
        super::commands::Decision {
            approve: true,
            argument_digest: review["argument_digest"].as_str().unwrap().into(),
        },
    )
    .await
    .unwrap();
    let mut approved = args.clone();
    approved["approval_id"] = json!(id);
    let mut tampered = approved.clone();
    tampered["input"]["amount_minor"] = json!("70000");
    assert!(
        super::registry::call(
            &api,
            actor.clone(),
            "else_collections_record_payment",
            tampered
        )
        .await
        .is_err()
    );
    let first = super::registry::call(
        &api,
        actor.clone(),
        "else_collections_record_payment",
        approved.clone(),
    )
    .await
    .unwrap();
    assert_eq!(first["status"], "committed");
    assert_eq!(
        super::registry::call(&api, actor, "else_collections_record_payment", approved)
            .await
            .unwrap(),
        first
    );
    let position = crate::billing::read(&f.db, f.actor.clone(), f.client.clone(), collection.id)
        .await
        .unwrap();
    assert_eq!(position["outstanding_minor"], "40000");
    assert_eq!(position["paid_minor"], "60000");
    let count = f
        .db
        .read(|tx| Ok(tx.query_row("SELECT count(*) FROM payments", [], |r| r.get::<_, i64>(0))?))
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn current_grant_revocation_is_rechecked_after_writer_admission() {
    use std::sync::{Arc, Condvar, Mutex};
    let f = Fixture::new().await;
    let (actor, _) = delegated(&f, "clients:read tasks:write", Some(f.client.clone())).await;
    let before = actor.clone();
    let client = f.client.clone();
    f.db.read(move |tx| security::require(tx, &before, "tasks.create", Some(&client)))
        .await
        .unwrap();
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let retained = release.clone();
    let db = f.db.clone();
    let (entered, receiving) = tokio::sync::oneshot::channel();
    let hold = tokio::spawn(async move {
        db.write(move |tx| {
            tx.execute(
                "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key IN ('tasks.create','tasks.manage')",
                [crate::validation::now()],
            )?;
            entered.send(()).unwrap();
            let (lock, cv) = &*retained;
            let mut ready = lock.lock().unwrap();
            while !*ready {
                ready = cv.wait(ready).unwrap();
            }
            Ok(())
        })
        .await
    });
    receiving.await.unwrap();
    let profile = crate::validation::json(br#"{"title":"Must not pass a revoked grant"}"#).unwrap();
    let call = crate::tasks::create(&f.db, actor, f.client.clone(), profile);
    tokio::pin!(call);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut call)
            .await
            .is_err()
    );
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    hold.await.unwrap().unwrap();
    assert!(call.await.is_err());
    let count =
        f.db.read(|tx| Ok(tx.query_row("SELECT count(*) FROM tasks", [], |r| r.get::<_, i64>(0))?))
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn cancelled_write_retains_admission_and_reconciles_committed_receipt_and_audit_failure_is_atomic()
 {
    use sha2::{Digest, Sha256};
    use std::sync::{Arc, Condvar, Mutex};
    let f = Fixture::new().await;
    let (actor, _) = delegated(
        &f,
        "clients:read tasks:read tasks:write",
        Some(f.client.clone()),
    )
    .await;
    let api = api(&f);
    let command = crate::validation::new_id();
    let args = json!({"client_id":f.client,"command_id":command,"input":{"title":"Committed after disconnect"}});
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&("else_tasks_create", args.clone())).unwrap())
    );
    let admitted = actor.clone().with_command(access::Command {
        id: command.clone(),
        tool: "else_tasks_create".into(),
        digest,
        kind: "task",
        approval_id: None,
        high_impact: false,
    });
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let retained = release.clone();
    let db = f.db.clone();
    let client = f.client.clone();
    let (entered, receiving) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        db.write(move |tx| {
            let profile = crate::validation::json(br#"{"title":"Committed after disconnect"}"#)?;
            let result = crate::tasks::create_in_transaction(tx, &admitted, &client, profile)?;
            entered.send(()).unwrap();
            let (lock, cv) = &*retained;
            let mut ready = lock.lock().unwrap();
            while !*ready {
                ready = cv.wait(ready).unwrap();
            }
            Ok(result)
        })
        .await
    });
    receiving.await.unwrap();
    running.abort();
    let later = f.db.write(|_| Ok(()));
    tokio::pin!(later);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut later)
            .await
            .is_err()
    );
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    later.await.unwrap();
    let receipt = super::registry::call(&api, actor.clone(), "else_tasks_create", args)
        .await
        .unwrap();
    assert_eq!(receipt["status"], "committed");
    f.connection().execute_batch("CREATE TRIGGER synthetic_mcp_audit_failure BEFORE INSERT ON audit_events WHEN NEW.resource_kind='task' BEGIN SELECT RAISE(ABORT,'synthetic audit rejection'); END;").unwrap();
    let failure=super::registry::call(&api,actor,"else_tasks_create",json!({"client_id":f.client,"command_id":crate::validation::new_id(),"input":{"title":"Must roll back together"}})).await;
    assert!(failure.is_err());
    let counts =
        f.db.read(|tx| {
            Ok((
                tx.query_row("SELECT count(*) FROM tasks", [], |r| r.get::<_, i64>(0))?,
                tx.query_row("SELECT count(*) FROM mcp_commands", [], |r| {
                    r.get::<_, i64>(0)
                })?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(counts, (1, 1));
}

#[tokio::test]
async fn expired_access_disabled_accounts_revoked_applications_and_scope_promotion_fail_closed() {
    let f = Fixture::new().await;
    let (actor, token) = delegated(&f, "clients:read", None).await;
    let delegation = actor.delegation().unwrap().clone();
    let user = f.actor.user_id.clone();
    let app = delegation.application_id.clone();
    let resource = oauth::resource(&config(&f));
    let (expired, hash) = access::opaque();
    f.db.write(move|tx|{
  let grant=crate::validation::new_id();tx.execute("INSERT INTO mcp_grants(id,user_id,application_id,resource,scopes,created_at,expires_at) VALUES(?1,?2,?3,?4,'clients:read','2000-01-01T00:00:00.000000Z','2100-01-01T00:00:00.000000Z')",rusqlite::params![grant,user,app,resource])?;
  tx.execute("INSERT INTO mcp_access_tokens(token_hash,grant_id,scopes,issued_at,expires_at) VALUES(?1,?2,'clients:read','2000-01-01T00:00:00.000000Z','2000-01-02T00:00:00.000000Z')",rusqlite::params![hash,grant])?;Ok(())
 }).await.unwrap();
    assert!(
        access::authenticate(
            &f.db,
            &expired,
            oauth::resource(&config(&f)),
            audit::request_id()
        )
        .await
        .is_err()
    );
    super::management::revoke_application(
        &f.db,
        f.actor.clone(),
        delegation.application_id,
        "1".into(),
    )
    .await
    .unwrap();
    assert!(
        access::authenticate(
            &f.db,
            &token,
            oauth::resource(&config(&f)),
            audit::request_id()
        )
        .await
        .is_err()
    );
    let app = application(&f).await;
    let code = code(&f, &app, "clients:read", None).await;
    let tokens = exchange(&f, &app, &code, &"v".repeat(64)).await.unwrap();
    let attempted=oauth::token(&f.db,&config(&f),query(json!({"grant_type":"refresh_token","client_id":app,"resource":oauth::resource(&config(&f)),"refresh_token":tokens["refresh_token"],"scope":"clients:read finance:write"}))).await;
    assert!(matches!(attempted, Err(Error::Invalid("invalid_scope"))));
    assert!(
        access::authenticate(
            &f.db,
            tokens["access_token"].as_str().unwrap(),
            oauth::resource(&config(&f)),
            audit::request_id()
        )
        .await
        .is_ok()
    );
    let user = f.actor.user_id.clone();
    f.db.write(move |tx| {
        tx.execute("UPDATE users SET status='disabled' WHERE id=?1", [user])?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        access::authenticate(
            &f.db,
            tokens["access_token"].as_str().unwrap(),
            oauth::resource(&config(&f)),
            audit::request_id()
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn all_reviewed_read_tools_reach_real_services_and_restore_revokes_delegation_but_preserves_commands()
 {
    let f = Fixture::new().await;
    let (actor, token) = delegated(&f, &access::SCOPES.join(" "), None).await;
    let api = api(&f);
    for d in super::registry::definitions()
        .iter()
        .filter(|d| d.kind.is_empty())
    {
        let mut args = json!({});
        for field in d.fields {
            let value = match *field {
                "client_id" => json!(f.client),
                "id" | "parent_id" => json!("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
                "provider" => json!("ga4"),
                "from" => json!("2000-01-01"),
                "to" => json!("2000-01-02"),
                "input" => {
                    json!({"title":"Synthetic preview","currency":"EUR","effective_from":"2020-01-01","lines":[{"description":"Synthetic service","kind":"custom","frequency":"none","quantity_micros":"1000000","unit_price_minor":"100","discount_bps":"0","tax_bps":"0"}]})
                }
                "currency" | "query" => continue,
                _ => panic!("unhandled reviewed field"),
            };
            args[*field] = value;
        }
        let result = super::registry::call(&api, actor.clone(), d.name, args).await;
        assert!(
            !matches!(result, Err(Error::Internal)),
            "{} failed its real-service read",
            d.name
        );
        assert!(
            !matches!(result, Err(Error::Invalid(_))),
            "{} rejected its advertised default read",
            d.name
        );
    }
    let command = crate::validation::new_id();
    let result=super::registry::call(&api,actor,"else_tasks_create",json!({"client_id":f.client,"command_id":command,"input":{"title":"Retained through restore"}})).await.unwrap();
    assert_eq!(result["status"], "committed");
    let key = f.directory.path().join("source-key.json");
    crate::credentials::provision(&key, &f.connection()).unwrap();
    let bundle = f.directory.path().join("checkpoint");
    crate::recovery::backup(&f.directory.path().join("else.sqlite3"), &key, &bundle).unwrap();
    let target = f.directory.path().join("restored");
    let restored_db = target.join("else.sqlite3");
    crate::recovery::restore(&bundle, &restored_db, &target.join("keyring.json")).unwrap();
    let restored = crate::db::Database::open(&restored_db, true).unwrap();
    let state = management::status(&restored, &config(&f), f.actor.clone())
        .await
        .unwrap();
    assert_eq!(state["enabled"], false);
    management::settings(
        &restored,
        f.actor.clone(),
        management::Settings {
            enabled: true,
            expected_revision: state["revision"].as_str().unwrap().into(),
        },
    )
    .await
    .unwrap();
    assert!(
        access::authenticate(
            &restored,
            &token,
            oauth::resource(&config(&f)),
            audit::request_id()
        )
        .await
        .is_err()
    );
    let counts = restored
        .read(|tx| {
            Ok((
                tx.query_row("SELECT count(*) FROM mcp_commands", [], |r| {
                    r.get::<_, i64>(0)
                })?,
                tx.query_row("SELECT count(*) FROM tasks", [], |r| r.get::<_, i64>(0))?,
                tx.query_row(
                    "SELECT count(*) FROM mcp_grants WHERE revoked_at IS NULL",
                    [],
                    |r| r.get::<_, i64>(0),
                )?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(counts, (1, 1, 0));
}

#[tokio::test]
async fn financial_intelligence_reads_intersect_brand_ceiling_and_finance_scope() {
    let f = Fixture::new().await;
    let other = crate::clients::create(
        &f.db,
        f.actor.clone(),
        crate::validation::json(br#"{"name":"Synthetic finance-only foreign brand"}"#).unwrap(),
    )
    .await
    .unwrap()
    .id;
    for client in [&f.client, &other] {
        crate::billing::create(&f.db,f.actor.clone(),client.clone(),crate::validation::json(br#"{"description":"Synthetic report charge","amount_minor":"70000","currency":"EUR"}"#).unwrap()).await.unwrap();
    }
    let (actor, _) = delegated(&f, "clients:read finance:read", Some(f.client.clone())).await;
    let service = api(&f);
    let report = super::registry::call(
        &service,
        actor.clone(),
        "else_financial_dashboard",
        json!({"query":{"currency":"EUR"}}),
    )
    .await
    .unwrap();
    assert_eq!(report["position"]["amount_minor"], "70000");
    assert!(report["expenses"].is_null());
    assert!(
        super::registry::call(
            &service,
            actor.clone(),
            "else_financial_receivables",
            json!({"query":{"client_id":other}})
        )
        .await
        .is_err()
    );
    let category = crate::validation::new_id();
    crate::finance::expenses::category(
        &f.db,
        f.actor.clone(),
        crate::finance::expenses::Category {
            id: category.clone(),
            name: "Synthetic scoped expense category".into(),
        },
    )
    .await
    .unwrap();
    crate::finance::expenses::create(&f.db,f.actor.clone(),crate::validation::json(&serde_json::to_vec(&json!({"command_id":crate::validation::new_id(),"client_id":f.client,"category_id":category,"title":"Synthetic private brand expense","vendor":"","description":"","currency":"EUR","amount_minor":"10000","expense_date":crate::billing::today(),"due_date":null})).unwrap()).unwrap()).await.unwrap();
    let (finance_only, _) = delegated(&f, "finance:read", None).await;
    let finance_only = super::registry::call(
        &service,
        finance_only,
        "else_financial_dashboard",
        json!({"query":{"currency":"EUR"}}),
    )
    .await
    .unwrap();
    assert_eq!(finance_only["expenses"]["position"]["recorded_minor"], "0");
    assert_eq!(finance_only["position"]["amount_minor"], "0");
    let (limited, _) = delegated(&f, "clients:read", Some(f.client.clone())).await;
    assert!(
        super::registry::call(&service, limited, "else_financial_dashboard", json!({}))
            .await
            .is_err()
    );
    let user = f.actor.user_id.clone();
    f.db.write(move|tx|{tx.execute("UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='billing.view' AND role_id IN(SELECT role_id FROM user_roles WHERE user_id=?2)",rusqlite::params![crate::validation::now(),user])?;Ok(())}).await.unwrap();
    assert!(
        super::registry::call(&service, actor, "else_financial_dashboard", json!({}))
            .await
            .is_err()
    );
}
