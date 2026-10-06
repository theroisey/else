//! Compatibility fixtures describe the retained PostgreSQL row representation;
//! domain records are created through real SQLite services, never runtime seeds.
use crate::{
    billing,
    credentials::Keyring,
    db, integrations,
    legacy_import::import,
    planning, pricing, private_files as files, recovery, reminders, tasks,
    testing::Fixture,
    validation,
    vault::{Operation, Scope, Vault},
};
use rusqlite::types::ValueRef;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

async fn populated() -> Fixture {
    let f = Fixture::new().await;
    let task = tasks::create(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        serde_json::from_value(
            json!({"title":"Synthetic retained task","due_at":"2026-10-01T00:00:00Z"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    planning::create(
        &f.db,
        f.actor.clone(),
        planning::Scope {
            client: f.client.clone(),
            plan: None,
        },
        planning::Profile::parse(
            br#"{"title":"Synthetic retained plan"}"#,
            &planning::Scope {
                client: f.client.clone(),
                plan: None,
            },
            false,
        )
        .unwrap(),
    )
    .await
    .unwrap();
    reminders::create(&f.db,f.actor.clone(),f.client.clone(),serde_json::from_value(json!({"title":"Synthetic retained reminder","scheduled_local":"2026-10-25T02:30:00","timezone":"Europe/Berlin","utc_offset_seconds":3600,"resource":{"kind":"task","id":task.id}})).unwrap()).await.unwrap();
    let bill=billing::create(&f.db,f.actor.clone(),f.client.clone(),serde_json::from_value(json!({"description":"Synthetic source invoice","amount_minor":"9007199254740993","currency":"KWD"})).unwrap()).await.unwrap();
    billing::record_payment(&f.db,f.actor.clone(),f.client.clone(),bill.id.clone(),serde_json::from_value(json!({"expected_revision":"1","command_id":validation::new_id(),"amount_minor":"9007199254740000","currency":"KWD","paid_on":"2026-10-06","method":"bank_transfer"})).unwrap()).await.unwrap();
    billing::cancel(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        bill.id,
        serde_json::from_value(json!({"expected_revision":"2","confirm":true})).unwrap(),
    )
    .await
    .unwrap();
    pricing::create(&f.db,f.actor.clone(),f.client.clone(),serde_json::from_value(json!({"title":"Synthetic source pricing","currency":"KWD","effective_from":"2026-10-01","lines":[{"description":"Synthetic source service","kind":"one_time","frequency":"none","quantity_micros":"1500000","unit_price_minor":"9007199254740993","discount_bps":"125","tax_bps":"1700","unit_cost_minor":"123"}]})).unwrap()).await.unwrap();
    let key = f.directory.path().join(".control/keyring.json");
    crate::credentials::provision(&key, &f.connection()).unwrap();
    let ring = Keyring::load(&key).unwrap();
    let vault = Vault::new(f.db.clone(), ring);
    for (provider, account, plaintext) in [
        (
            "meta_ads",
            "8101",
            b"synthetic-retained-meta-token".to_vec(),
        ),
        (
            "woocommerce",
            "https://synthetic.invalid",
            format!(
                "{{\"consumer_key\":\"ck_{}\",\"consumer_secret\":\"cs_{}\"}}",
                "a".repeat(40),
                "b".repeat(40)
            )
            .into_bytes(),
        ),
    ] {
        let connection = integrations::create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            provider.into(),
            account.into(),
        )
        .await
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let scope = Scope {
            client: f.client.clone(),
            connection,
            website: None,
        };
        let checkpoint = vault.inspect(f.actor.clone(), scope.clone()).await.unwrap();
        let prepared = vault
            .prepare(
                f.actor.clone(),
                scope,
                checkpoint,
                Operation::Replace(zeroize::Zeroizing::new(plaintext)),
            )
            .await
            .unwrap();
        vault.persist(f.actor.clone(), prepared).await.unwrap();
    }
    let scope = Scope {
        client: f.client.clone(),
        connection: f
            .connection()
            .query_row(
                "SELECT id FROM integration_connections WHERE provider='meta_ads'",
                [],
                |r| r.get(0),
            )
            .unwrap(),
        website: None,
    };
    let ring = Keyring::load(&key).unwrap();
    let service = crate::synchronization::Synchronization::new(
        f.db.clone(),
        Vault::new(f.db.clone(), ring.clone()),
        ring,
    );
    let period =
        crate::sync_period::Period::calendar("meta_ads", "2026-10-01", "2026-10-06").unwrap();
    service
        .enqueue(f.actor.clone(), scope.clone(), 2, period.clone(), None)
        .await
        .unwrap();
    let job = service.claim().await.unwrap().unwrap();
    let stamp = crate::history_cursor::canonical(&validation::now()).unwrap();
    let workspace =
        crate::providers::workspace::Workspace::Meta(Box::new(crate::providers::meta::Workspace {
            report: crate::providers::meta::Report {
                client_id: f.client.clone(),
                connection_id: scope.connection.clone(),
                graph_version: "v26.0".into(),
                currency: "EUR".into(),
                timezone: "Europe/Istanbul".into(),
                since: "2026-10-01".into(),
                until: "2026-10-06".into(),
                days: vec![],
                totals: crate::providers::meta::Metrics {
                    spend_decimal: "0".into(),
                    impressions: "0".into(),
                    clicks: "0".into(),
                    ctr_percent: None,
                    cpc_decimal: None,
                    cpm_decimal: None,
                },
                attribution_status: "unavailable".into(),
            },
            collected_from: stamp.clone(),
            collected_through: stamp,
        }));
    service.finish(job, Some(workspace)).await.unwrap();
    service
        .enqueue(f.actor.clone(), scope, 3, period, None)
        .await
        .unwrap();
    service.claim().await.unwrap().unwrap();
    f
}
fn export_fixture(f: &Fixture, destination: &Path) {
    files::directory(destination, true).unwrap();
    let schema: Value =
        serde_json::from_str(include_str!("../migrations/postgres-source-schema.json")).unwrap();
    let connection = f.connection();
    let mut counts = BTreeMap::new();
    let mut rows = Vec::new();
    for table in recovery::TABLES
        .iter()
        .copied()
        .filter(|t| *t != "import_receipts")
    {
        let definition = schema
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["table"] == table)
            .unwrap();
        let columns = definition["columns"].as_array().unwrap();
        let projection = columns
            .iter()
            .map(|c| {
                if c["name"] == "creation_xid" {
                    "'1' AS creation_xid".into()
                } else {
                    c["name"].as_str().unwrap().to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        let mut statement = connection
            .prepare(&format!("SELECT {projection} FROM {table}"))
            .unwrap();
        let mut data = statement.query([]).unwrap();
        let mut total = 0i64;
        while let Some(row) = data.next().unwrap() {
            let mut fields = BTreeMap::new();
            for (index, column) in columns.iter().enumerate() {
                let value = match row.get_ref(index).unwrap() {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(value) if column["type"] == "bool" => Value::Bool(value != 0),
                    ValueRef::Integer(value) => json!(value),
                    ValueRef::Text(value) if column["type"] == "jsonb" => {
                        serde_json::from_slice(value).unwrap()
                    }
                    ValueRef::Text(value) => json!(std::str::from_utf8(value).unwrap()),
                    ValueRef::Blob(value) => {
                        json!(value.iter().map(|b| format!("{b:02x}")).collect::<String>())
                    }
                    _ => panic!("unexpected approximate value"),
                };
                fields.insert(column["name"].as_str().unwrap().to_owned(), value);
            }
            rows.push(json!({"kind":"row","table":table,"row":fields}));
            total += 1;
        }
        if table == "permissions" {
            for key in ["releases.view", "releases.manage"] {
                rows.push(json!({"kind":"row","table":table,"row":{"permission_key":key,"scope_kind":"global","description":"Retired version checker"}}));
                total += 1;
            }
        }
        counts.insert(table, total);
    }
    let mut bytes=serde_json::to_vec(&json!({"kind":"header","format":1,"source":"postgresql","version":28,"schema":schema,"counts":counts})).unwrap();
    bytes.push(b'\n');
    for row in rows {
        bytes.extend(serde_json::to_vec(&row).unwrap());
        bytes.push(b'\n');
    }
    bytes.extend(serde_json::to_vec(&json!({"kind":"complete","counts":counts})).unwrap());
    bytes.push(b'\n');
    files::write(&destination.join("postgres.jsonl"), &bytes, 0o600).unwrap();
    let keys = files::read(&f.directory.path().join(".control/keyring.json"), 8192).unwrap();
    files::write(&destination.join("keyring.json"), &keys, 0o400).unwrap();
    let manifest = json!({"format":1,"source":"postgresql","version":28,"exported_at":validation::now(),"source_sha256":format!("{:x}",Sha256::digest(&bytes)),"keyring_sha256":format!("{:x}",Sha256::digest(&keys))});
    files::write(
        &destination.join("manifest.json"),
        &serde_json::to_vec(&manifest).unwrap(),
        0o600,
    )
    .unwrap();
}
#[tokio::test]
async fn complete_import_keeps_authority_dst_exact_finance_history_and_retained_envelopes() {
    let f = populated().await;
    let bundle = f.directory.path().join("export");
    export_fixture(&f, &bundle);
    let database = f.directory.path().join("destination/else.sqlite3");
    let keys = f.directory.path().join("destination/.control/keyring.json");
    let summary = import(&bundle, &database, &keys).unwrap();
    assert_eq!(summary.removed_version_checker_rows["permissions"], 2);
    assert_eq!(
        summary.imported_rows["audit_events"],
        summary.source_rows["audit_events"]
    );
    let source = f.connection();
    let mut target = db::connection(&database).unwrap();
    assert_eq!(
        recovery::verify(&mut target, &Keyring::load(&keys).unwrap()).unwrap()["import_receipts"],
        1
    );
    assert!(db::Database::open(&database, true).is_ok());
    for table in [
        "users",
        "sessions",
        "user_roles",
        "client_scopes",
        "clients",
        "tasks",
        "plans",
        "reminders",
        "collections",
        "payments",
        "pricing_lines",
        "integration_connections",
        "integration_credentials",
        "integration_encryption_keys",
        "analytics_sync_jobs",
    ] {
        let sql = format!("SELECT * FROM {table} ORDER BY 1");
        let values = |connection: &rusqlite::Connection| {
            let mut stmt = connection.prepare(&sql).unwrap();
            let width = stmt.column_count();
            stmt.query_map([], |r| {
                (0..width)
                    .map(|i| r.get::<_, rusqlite::types::Value>(i))
                    .collect::<std::result::Result<Vec<_>, _>>()
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap()
        };
        assert_eq!(values(&source), values(&target), "{table}");
    }
    let source_key = Keyring::load(&f.directory.path().join(".control/keyring.json")).unwrap();
    assert_ne!(source_key.active(), Keyring::load(&keys).unwrap().active());
    assert!(import(&bundle, &database, &keys).is_err());
}
#[tokio::test]
#[ignore = "requires an empty disposable PostgreSQL v28 compatibility container"]
async fn actual_postgresql_export_import_retains_guarded_domain_records() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let container = std::env::var("ELSE_TEST_POSTGRES_CONTAINER")
        .expect("disposable PostgreSQL container required");
    assert!(
        container.starts_with("else-rust-import-test-")
            || container.starts_with("else-compat-test-")
    );
    let f = populated().await;
    let local = f.directory.path().join("fixture");
    export_fixture(&f, &local);
    let lines: Vec<Value> = std::fs::read_to_string(local.join("postgres.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let definitions = lines[0]["schema"].as_array().unwrap();
    let mut sql = String::from(
        "BEGIN; SET LOCAL timezone='UTC'; DO $$ BEGIN IF EXISTS(SELECT 1 FROM app.users) THEN RAISE EXCEPTION 'fixture must be empty'; END IF; END $$;\n",
    );
    let literal = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let mut cancellations = Vec::new();
    for line in lines.iter().filter(|l| l["kind"] == "row") {
        let table = line["table"].as_str().unwrap();
        if [
            "permissions",
            "roles",
            "role_permissions",
            "billing_currencies",
        ]
        .contains(&table)
        {
            continue;
        }
        let definition = definitions.iter().find(|d| d["table"] == table).unwrap();
        let columns = definition["columns"].as_array().unwrap();
        let row = &line["row"];
        let mut fields = Vec::new();
        let mut names = Vec::new();
        for column in columns {
            let name = column["name"].as_str().unwrap();
            let kind = column["type"].as_str().unwrap();
            let value = &row[name];
            names.push(name);
            let encoded = if table == "collections" && name == "cancelled_at" {
                if !value.is_null() {
                    cancellations.push(format!(
                        "UPDATE app.collections SET cancelled_at={} WHERE id={};",
                        literal(value.as_str().unwrap()),
                        literal(row["id"].as_str().unwrap())
                    ));
                }
                "NULL".into()
            } else if kind == "jsonb" {
                format!("{}::jsonb", literal(&serde_json::to_string(value).unwrap()))
            } else if value.is_null() {
                "NULL".into()
            } else if kind == "xid8" {
                "pg_current_xact_id()".into()
            } else if kind == "bytea" {
                format!("decode({},'hex')", literal(value.as_str().unwrap()))
            } else if kind == "bool" {
                if value.as_bool().unwrap() {
                    "TRUE".into()
                } else {
                    "FALSE".into()
                }
            } else if matches!(kind, "int2" | "int4" | "int8") {
                value.to_string()
            } else {
                literal(value.as_str().unwrap())
            };
            fields.push(encoded);
        }
        sql.push_str(&format!(
            "INSERT INTO app.{table} ({}) VALUES ({});\n",
            names.join(","),
            fields.join(",")
        ));
    }
    for statement in cancellations {
        sql.push_str(&statement);
        sql.push('\n');
    }
    sql.push_str("COMMIT;\n");
    let mut child = Command::new("docker")
        .args([
            "exec",
            "--user",
            "postgres",
            "-i",
            &container,
            "psql",
            "-X",
            "-q",
            "-h",
            "/tmp",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(sql.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    if !output.status.success() {
        let text = String::from_utf8_lossy(&output.stderr);
        let kind = if text.contains("constraint") {
            "legacy_constraint_rejected"
        } else {
            "legacy_fixture_rejected"
        };
        panic!("{kind}");
    }
    let export = f.directory.path().join("actual-export");
    let status = Command::new("python3")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("tools/export-postgres.py"),
        )
        .args([
            "--container",
            &container,
            "--database",
            "postgres",
            "--confirmed-offline",
            "--key-file",
        ])
        .arg(f.directory.path().join(".control/keyring.json"))
        .arg("--output")
        .arg(&export)
        .output()
        .unwrap();
    let diagnostic = String::from_utf8_lossy(&status.stderr);
    let safe_code = match diagnostic.trim() {
        "private_export_directory_required" => "private_export_directory_required",
        "private_key_source_required" => "private_key_source_required",
        "isolated_offline_clone_required" => "isolated_offline_clone_required",
        "source_export_failed" => "source_export_failed",
        "unsupported_source_schema" => "unsupported_source_schema",
        _ => "exporter_failure",
    };
    assert!(
        status.status.success(),
        "actual_exporter_failed: {safe_code}"
    );
    let target = f.directory.path().join("actual-import/else.sqlite3");
    let keys = f
        .directory
        .path()
        .join("actual-import/.control/keyring.json");
    let summary = import(&export, &target, &keys).unwrap();
    assert_eq!(summary.removed_version_checker_rows["permissions"], 2);
    assert_eq!(summary.removed_version_checker_rows["role_permissions"], 2);
    assert_eq!(summary.source_rows["analytics_sync_jobs"], 2);
    assert_eq!(summary.source_rows["analytics_snapshots"], 1);
    let mut restored = db::connection(&target).unwrap();
    recovery::verify(&mut restored, &Keyring::load(&keys).unwrap()).unwrap();
    let database = db::Database::open(&target, true).unwrap();
    let source = f.connection();
    let invoice: String = source
        .query_row("SELECT id FROM collections", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        billing::read(&f.db, f.actor.clone(), f.client.clone(), invoice.clone())
            .await
            .unwrap(),
        billing::read(&database, f.actor.clone(), f.client.clone(), invoice)
            .await
            .unwrap()
    );
    assert_eq!(
        restored
            .query_row::<Vec<u8>, _, _>(
                "SELECT envelope FROM integration_credentials ORDER BY connection_id LIMIT 1",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        source
            .query_row::<Vec<u8>, _, _>(
                "SELECT envelope FROM integration_credentials ORDER BY connection_id LIMIT 1",
                [],
                |r| r.get(0)
            )
            .unwrap()
    );
}
#[tokio::test]
async fn incomplete_counts_schema_ledger_and_missing_keys_refuse_publication() {
    let f = populated().await;
    for mutation in ["truncated", "counts", "schema", "ledger", "missing_keys"] {
        let bundle = f.directory.path().join(format!("export-{mutation}"));
        export_fixture(&f, &bundle);
        let source = bundle.join("postgres.jsonl");
        let mut lines: Vec<Value> = std::fs::read_to_string(&source)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        match mutation {
            "truncated" => {
                lines.pop();
            }
            "counts" => lines[0]["counts"]["users"] = json!(2),
            "schema" => lines[0]["schema"][0]["columns"][0]["name"] = json!("unreviewed"),
            "ledger" => {
                let row = lines
                    .iter_mut()
                    .find(|v| v["table"] == "collections")
                    .unwrap();
                row["row"]["paid_minor"] = json!(0);
            }
            _ => std::fs::remove_file(bundle.join("keyring.json")).unwrap(),
        }
        let raw = lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap() + "\n")
            .collect::<String>();
        std::fs::write(&source, &raw).unwrap();
        let manifest = bundle.join("manifest.json");
        let mut value: Value =
            serde_json::from_slice(&files::read(&manifest, 16_384).unwrap()).unwrap();
        value["source_sha256"] = json!(format!("{:x}", Sha256::digest(raw.as_bytes())));
        std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        let database = f
            .directory
            .path()
            .join(format!("failed-{mutation}/else.sqlite3"));
        let key = database.parent().unwrap().join(".control/keyring.json");
        assert!(import(&bundle, &database, &key).is_err(), "{mutation}");
        assert!(!database.exists() && !key.exists(), "{mutation}");
    }
}
