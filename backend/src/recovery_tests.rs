use crate::{
    billing, clients,
    credentials::Keyring,
    db, integrations, pricing, private_files as files,
    recovery::{backup, hash_file, restore, verify},
    testing::Fixture,
    validation,
    vault::{Operation, Scope, Vault},
};
use serde_json::json;
use std::{fs, os::unix::fs::PermissionsExt};
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn online_backup_and_fresh_key_restore_preserve_finance_identity_history_and_ciphertext() {
    let f = Fixture::new().await;
    let source = f.directory.path().join("else.sqlite3");
    let key_file = f.directory.path().join(".control/integration-keyring.json");
    crate::credentials::provision(&key_file, &f.connection()).unwrap();
    let ring = Keyring::load(&key_file).unwrap();
    let vault = Vault::new(f.db.clone(), ring.clone());
    let id = integrations::create(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        "meta_ads".into(),
        "7001".into(),
    )
    .await
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let scope = Scope {
        client: f.client.clone(),
        connection: id,
        website: None,
    };
    let checkpoint = vault.inspect(f.actor.clone(), scope.clone()).await.unwrap();
    let prepared = vault
        .prepare(
            f.actor.clone(),
            scope.clone(),
            checkpoint,
            Operation::Replace(zeroize::Zeroizing::new(
                b"synthetic-retained-token".to_vec(),
            )),
        )
        .await
        .unwrap();
    vault.persist(f.actor.clone(), prepared).await.unwrap();
    pricing::create(&f.db,f.actor.clone(),f.client.clone(),serde_json::from_value(json!({"title":"Synthetic exact pricing","currency":"KWD","effective_from":"2026-10-01","lines":[{"description":"Synthetic service","kind":"one_time","frequency":"none","quantity_micros":"1500000","unit_price_minor":"9007199254740993","discount_bps":"125","tax_bps":"1700","unit_cost_minor":"123"}]})).unwrap()).await.unwrap();
    let bill=billing::create(&f.db,f.actor.clone(),f.client.clone(),serde_json::from_value(json!({"description":"Synthetic retained invoice","amount_minor":"9007199254740993","currency":"KWD"})).unwrap()).await.unwrap();
    let payment = json!({"expected_revision":"1","command_id":validation::new_id(),"amount_minor":"9007199254740000","currency":"KWD","paid_on":"2026-10-06","method":"bank_transfer"});
    billing::record_payment(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        bill.id.clone(),
        serde_json::from_value(payment.clone()).unwrap(),
    )
    .await
    .unwrap();
    let before = billing::read(&f.db, f.actor.clone(), f.client.clone(), bill.id.clone())
        .await
        .unwrap();
    let live = files::RuntimeLease::acquire(&source).unwrap();
    let bundle = f.directory.path().join("backups/synthetic-bundle");
    let db = f.db.clone();
    let actor = f.actor.clone();
    let writes = tokio::spawn(async move {
        for index in 0..20 {
            clients::create(
                &db,
                actor.clone(),
                serde_json::from_value(json!({"name":format!("Synthetic concurrent {index}")}))
                    .unwrap(),
            )
            .await
            .unwrap();
        }
    });
    let inputs = (source.clone(), key_file.clone(), bundle.clone());
    tokio::task::spawn_blocking(move || backup(&inputs.0, &inputs.1, &inputs.2))
        .await
        .unwrap()
        .unwrap();
    writes.await.unwrap();
    let original_db = hash_file(&bundle.join("database.sqlite3")).unwrap();
    let original_key = files::read(&bundle.join("keyring.json"), 8192).unwrap();
    fs::set_permissions(
        bundle.join("database.sqlite3"),
        fs::Permissions::from_mode(0o400),
    )
    .unwrap();
    fs::set_permissions(&bundle, fs::Permissions::from_mode(0o500)).unwrap();
    let target = f.directory.path().join("restored/else.sqlite3");
    let restored_key = f
        .directory
        .path()
        .join("restored/.control/integration-keyring.json");
    restore(&bundle, &target, &restored_key).unwrap();
    assert_eq!(
        hash_file(&bundle.join("database.sqlite3")).unwrap(),
        original_db
    );
    assert_eq!(
        &*files::read(&bundle.join("keyring.json"), 8192).unwrap(),
        &*original_key
    );
    assert!(restore(&bundle, &target, &restored_key).is_err());
    let restored_ring = Keyring::load(&restored_key).unwrap();
    assert_ne!(restored_ring.active(), ring.active());
    let mut captured = db::readonly_connection(&bundle.join("database.sqlite3")).unwrap();
    assert!(captured.execute("DELETE FROM sessions", []).is_err());
    let counts = verify(&mut captured, &ring).unwrap();
    let mut restored = db::connection(&target).unwrap();
    assert_eq!(verify(&mut restored, &restored_ring).unwrap(), counts);
    restored_ring.preflight(&restored, true, true).unwrap();
    let database = db::Database::open(&target, true).unwrap();
    assert_eq!(
        billing::read(
            &database,
            f.actor.clone(),
            f.client.clone(),
            bill.id.clone()
        )
        .await
        .unwrap(),
        before
    );
    assert!(
        billing::record_payment(
            &database,
            f.actor.clone(),
            f.client.clone(),
            bill.id,
            serde_json::from_value(payment).unwrap()
        )
        .await
        .unwrap()
        .replayed
    );
    let restored_vault = Vault::new(database.clone(), restored_ring.clone());
    let checkpoint = restored_vault
        .inspect(f.actor.clone(), scope.clone())
        .await
        .unwrap();
    let prepared = restored_vault
        .prepare(
            f.actor.clone(),
            scope.clone(),
            checkpoint.clone(),
            Operation::Rewrap,
        )
        .await
        .unwrap();
    let rewrapped = restored_vault
        .persist(f.actor.clone(), prepared)
        .await
        .unwrap();
    assert_eq!(rewrapped.generation, checkpoint.generation);
    assert_eq!(
        restored
            .query_row::<i64, _, _>(
                "SELECT reservations FROM integration_encryption_keys WHERE key_label=?1",
                [restored_ring.active().0],
                |r| r.get(0)
            )
            .unwrap(),
        1
    );
    assert!(backup(&source, &key_file, &bundle).is_err());
    assert!(matches!(
        restore(&bundle, &source, &key_file),
        Err(crate::error::Error::Conflict("application_is_running"))
    ));
    drop(live);
    // Let the explicitly owned fixture destructor remove its read-only source.
    fs::set_permissions(&bundle, fs::Permissions::from_mode(0o700)).unwrap();
}
#[tokio::test]
async fn damaged_missing_or_linked_artifacts_never_install_data_or_keys() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new().await;
    let source = f.directory.path().join("else.sqlite3");
    let key = f.directory.path().join(".control/keyring.json");
    crate::credentials::provision(&key, &f.connection()).unwrap();
    let bundle = f.directory.path().join("backups/bundle");
    backup(&source, &key, &bundle).unwrap();
    let legacy_parent = f.directory.path().join("legacy-target");
    files::directory(&legacy_parent.join("18/docker"), true).unwrap();
    let legacy = legacy_parent.join("18/docker/PG_VERSION");
    files::write(&legacy, b"18\n", 0o600).unwrap();
    let legacy_database = legacy_parent.join("else.sqlite3");
    let legacy_key = legacy_parent.join(".control/keyring.json");
    assert!(matches!(
        restore(&bundle, &legacy_database, &legacy_key),
        Err(crate::error::Error::Conflict(
            "restore_requires_empty_storage"
        ))
    ));
    assert!(!legacy_database.exists() && !legacy_key.exists());
    assert_eq!(&*files::read(&legacy, 16).unwrap(), b"18\n");
    let target = f.directory.path().join("target/else.sqlite3");
    let target_key = f.directory.path().join("target/.control/keyring.json");
    let source_key = bundle.join("keyring.json");
    fs::rename(&source_key, bundle.join("missing.json")).unwrap();
    assert!(restore(&bundle, &target, &target_key).is_err());
    assert!(!target.exists() && !target_key.exists());
    assert!(matches!(
        db::Database::open(&target, true),
        Err(crate::error::Error::Conflict("restore_incomplete"))
    ));
    fs::rename(bundle.join("missing.json"), &source_key).unwrap();
    let target = f.directory.path().join("linked-target/else.sqlite3");
    let target_key = f
        .directory
        .path()
        .join("linked-target/.control/keyring.json");
    let linked = f.directory.path().join("linked");
    symlink(&bundle, &linked).unwrap();
    assert!(restore(&linked, &target, &target_key).is_err());
    assert!(!target.exists() && !target_key.exists());
    assert!(matches!(
        db::Database::open(&target, true),
        Err(crate::error::Error::Conflict("restore_incomplete"))
    ));
    let target = f.directory.path().join("corrupt-target/else.sqlite3");
    let target_key = f
        .directory
        .path()
        .join("corrupt-target/.control/keyring.json");
    let artifact = bundle.join("database.sqlite3");
    let mut corrupted = files::read(&artifact, 4_194_304).unwrap();
    corrupted[100] ^= 1;
    fs::write(&artifact, &*corrupted).unwrap();
    assert!(restore(&bundle, &target, &target_key).is_err());
    assert!(!target.exists() && !target_key.exists());
    assert!(matches!(
        db::Database::open(&target, true),
        Err(crate::error::Error::Conflict("restore_incomplete"))
    ));
    let missing = f.directory.path().join("missing.sqlite3");
    assert!(backup(&missing, &key, &f.directory.path().join("not-published")).is_err());
    assert!(!missing.exists());
}
