use super::*;
use crate::testing::Fixture;
use base64::Engine;

fn ring() -> Keyring {
    Keyring::parse(&serde_json::to_vec(&serde_json::json!({"active_key_id":"otp-fixture","keys":[{"id":"otp-fixture","key_base64":base64::engine::general_purpose::STANDARD.encode([91u8;32])}]})).unwrap()).unwrap()
}
fn service(f: &Fixture) -> Otp {
    Otp {
        db: f.db.clone(),
        ring: ring(),
        policy: Policy::default(),
        enabled: true,
    }
}
async fn issue(otp: &Otp, email: &str, browser: &str) -> Challenge {
    otp.request(
        RequestCode {
            email: email.into(),
        },
        "fixture-peer".into(),
        browser,
    )
    .await
    .unwrap()
}
fn delivered(f: &Fixture, otp: &Otp, challenge: &Challenge) -> String {
    let conn = f.connection();
    let (user, envelope): (String, Vec<u8>) = conn
        .query_row(
            "SELECT user_id,envelope FROM auth_email_outbox WHERE challenge_id=?1",
            [&challenge.challenge_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let raw = otp
        .ring
        .open(
            &binding(&user, &challenge.challenge_id),
            &crate::credentials::Envelope::parse(envelope).unwrap(),
        )
        .unwrap();
    let payload: super::super::mail::Payload = serde_json::from_slice(&raw).unwrap();
    conn.execute(
        "UPDATE auth_otp_challenges SET state='delivered' WHERE id=?1",
        [&challenge.challenge_id],
    )
    .unwrap();
    conn.execute(
        "UPDATE auth_email_outbox SET state='sent',envelope=NULL WHERE challenge_id=?1",
        [&challenge.challenge_id],
    )
    .unwrap();
    payload.code.clone()
}
async fn verify(otp: &Otp, c: &Challenge, code: &str, browser: &str) -> Result<LoginResult> {
    otp.verify(
        VerifyCode {
            challenge_id: c.challenge_id.clone(),
            code: code.into(),
        },
        "fixture-peer".into(),
        browser,
        audit::request_id(),
    )
    .await
}
fn cooldown(f: &Fixture) {
    f.connection()
        .execute(
            "UPDATE auth_otp_rate_events SET occurred_at=occurred_at-61 WHERE kind='request_email'",
            [],
        )
        .unwrap();
}

#[test]
fn secure_codes_and_domain_separated_keyed_digests() {
    let ring = ring();
    let mut unique = std::collections::BTreeSet::new();
    for _ in 0..1000 {
        let c = generate().unwrap();
        assert_eq!(c.len(), 6);
        assert!(c.bytes().all(|b| b.is_ascii_digit()));
        unique.insert(c.to_string());
    }
    assert!(unique.len() > 900);
    let original = ring
        .otp_digest(
            "otp-fixture",
            &["challenge", "user", "authentication", "000042"],
        )
        .unwrap();
    assert_eq!(original.len(), 32);
    for fields in [
        ["other", "user", "authentication", "000042"],
        ["challenge", "other", "authentication", "000042"],
        ["challenge", "user", "recovery", "000042"],
        ["challenge", "user", "authentication", "000043"],
    ] {
        assert_ne!(original, ring.otp_digest("otp-fixture", &fields).unwrap());
    }
}
#[tokio::test]
async fn delivery_required_browser_binding_single_use_concurrency_and_existing_sessions() {
    let f = Fixture::new().await;
    let otp = service(&f);
    let nonce = secret().0;
    let c = issue(&otp, "ADMIN@example.com", &nonce).await;
    assert_eq!(c.expires_in, 180);
    assert_eq!(c.resend_after, 60);
    assert!(verify(&otp, &c, "000000", &nonce).await.is_err());
    let code = delivered(&f, &otp, &c);
    assert!(verify(&otp, &c, &code, &secret().0).await.is_err());
    let (one, two) = tokio::join!(
        verify(&otp, &c, &code, &nonce),
        verify(&otp, &c, &code, &nonce)
    );
    assert_eq!(usize::from(one.is_ok()) + usize::from(two.is_ok()), 1);
    let login = one.or(two).unwrap();
    assert!(Auth::csrf(&login.session.actor, &login.csrf, &login.csrf));
    assert!(!Auth::csrf(&login.session.actor, &login.csrf, "wrong"));
    assert!(
        f.auth
            .current(&login.token, audit::request_id())
            .await
            .is_ok()
    );
    assert!(verify(&otp, &c, &code, &nonce).await.is_err());
    f.auth.logout(login.session.actor).await.unwrap();
    assert!(
        f.auth
            .current(&login.token, audit::request_id())
            .await
            .is_err()
    );
    // The fixture's pre-migration-style session remains valid.
    f.db.read(move |tx| security::fresh(tx, &f.actor))
        .await
        .unwrap();
}
#[tokio::test]
async fn attempts_survive_service_restart_and_exhaust_at_five() {
    let f = Fixture::new().await;
    let otp = service(&f);
    let nonce = secret().0;
    let c = issue(&otp, "admin@example.com", &nonce).await;
    let code = delivered(&f, &otp, &c);
    let wrong = if code == "000000" { "000001" } else { "000000" };
    for _ in 0..5 {
        let mut restarted = service(&f);
        restarted.db = Database::open(&f.directory.path().join("else.sqlite3"), true).unwrap();
        assert!(verify(&restarted, &c, wrong, &nonce).await.is_err());
    }
    let state: (i64, String) = f
        .connection()
        .query_row(
            "SELECT attempts,state FROM auth_otp_challenges WHERE id=?1",
            [&c.challenge_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, (5, "exhausted".into()));
    assert!(verify(&otp, &c, &code, &nonce).await.is_err());
}
#[tokio::test]
async fn expiry_replacement_disabled_identity_and_audit_failure_never_create_session() {
    let f = Fixture::new().await;
    let otp = service(&f);
    let nonce = secret().0;
    let old = issue(&otp, "admin@example.com", &nonce).await;
    let old_code = delivered(&f, &otp, &old);
    cooldown(&f);
    let c = issue(&otp, "admin@example.com", &nonce).await;
    let code = delivered(&f, &otp, &c);
    assert!(verify(&otp, &old, &old_code, &nonce).await.is_err());
    f.connection().execute_batch("CREATE TRIGGER otp_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    assert!(verify(&otp, &c, &code, &nonce).await.is_err());
    assert_eq!(
        f.connection()
            .query_row::<String, _, _>(
                "SELECT state FROM auth_otp_challenges WHERE id=?1",
                [&c.challenge_id],
                |r| r.get(0)
            )
            .unwrap(),
        "delivered"
    );
    f.connection()
        .execute_batch("DROP TRIGGER otp_audit_failure")
        .unwrap();
    f.connection()
        .execute(
            "UPDATE auth_otp_challenges SET created_at=?1-180,expires_at=?1 WHERE id=?2",
            params![Utc::now().timestamp(), c.challenge_id],
        )
        .unwrap();
    assert!(verify(&otp, &c, &code, &nonce).await.is_err());
    cooldown(&f);
    let next = issue(&otp, "admin@example.com", &nonce).await;
    let code = delivered(&f, &otp, &next);
    f.connection()
        .execute(
            "UPDATE users SET status='disabled' WHERE id=?1",
            [&f.actor.user_id],
        )
        .unwrap();
    assert!(verify(&otp, &next, &code, &nonce).await.is_err());
}
#[tokio::test]
async fn unknown_and_disabled_accounts_have_same_public_shape_without_mail_or_registration() {
    let f = Fixture::new().await;
    let otp = service(&f);
    let nonce = secret().0;
    let active = issue(&otp, "admin@example.com", &nonce).await;
    let missing = issue(&otp, "missing@example.com", &nonce).await;
    f.connection()
        .execute(
            "UPDATE users SET status='disabled' WHERE id=?1",
            [&f.actor.user_id],
        )
        .unwrap();
    cooldown(&f);
    let disabled = issue(&otp, "admin@example.com", &nonce).await;
    assert_eq!(active.expires_in, missing.expires_in);
    assert_eq!(active.resend_after, disabled.resend_after);
    assert_eq!(
        f.connection()
            .query_row::<i64, _, _>("SELECT count(*) FROM auth_email_outbox", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert_eq!(
        f.connection()
            .query_row::<i64, _, _>("SELECT count(*) FROM users", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert!(verify(&otp, &missing, "000000", &nonce).await.is_err());
    assert!(verify(&otp, &disabled, "000000", &nonce).await.is_err());
}
#[tokio::test]
async fn independent_durable_limits_cooldown_boundaries_and_admission() {
    let f = Fixture::new().await;
    let nonce = secret().0;
    let mut otp = service(&f);
    issue(&otp, "unknown@example.com", &nonce).await;
    assert_eq!(
        otp.request(
            RequestCode {
                email: "unknown@example.com".into()
            },
            "another-peer".into(),
            &nonce
        )
        .await
        .err()
        .unwrap()
        .code(),
        "authentication_rate_limited"
    );
    for _ in 0..2 {
        cooldown(&f);
        issue(&otp, "unknown@example.com", &nonce).await;
    }
    cooldown(&f);
    assert!(
        service(&f)
            .request(
                RequestCode {
                    email: "unknown@example.com".into()
                },
                "rotated-peer".into(),
                &nonce
            )
            .await
            .is_err()
    );
    otp.policy.peer_requests = 3;
    assert!(
        otp.request(
            RequestCode {
                email: "different@example.com".into()
            },
            "fixture-peer".into(),
            &nonce
        )
        .await
        .is_err()
    );
    otp.policy.global_requests = 3;
    assert!(
        otp.request(
            RequestCode {
                email: "different@example.com".into()
            },
            "rotated-peer".into(),
            &nonce
        )
        .await
        .is_err()
    );
    f.connection()
        .execute(
            "UPDATE auth_otp_rate_events SET occurred_at=?1",
            [Utc::now().timestamp() - 900],
        )
        .unwrap();
    issue(&otp, "unknown@example.com", &nonce).await;
    let count: i64 = f
        .connection()
        .query_row("SELECT count(*) FROM auth_otp_challenges", [], |r| r.get(0))
        .unwrap();
    otp.enabled = false;
    assert!(
        otp.request(
            RequestCode {
                email: "admin@example.com".into()
            },
            "fresh-peer".into(),
            &nonce
        )
        .await
        .is_err()
    );
    assert_eq!(
        f.connection()
            .query_row::<i64, _, _>("SELECT count(*) FROM auth_otp_challenges", [], |r| r.get(0))
            .unwrap(),
        count
    );
}
#[tokio::test]
async fn encrypted_outbox_and_redacted_audits_and_operator_mailbox_recovery() {
    let f = Fixture::new().await;
    let otp = service(&f);
    let nonce = secret().0;
    let c = issue(&otp, "admin@example.com", &nonce).await;
    let code = delivered(&f, &otp, &c);
    let audit: String = f
        .connection()
        .query_row(
            "SELECT group_concat(before_state||after_state||metadata) FROM audit_events",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!audit.contains(&code));
    assert!(!audit.contains("admin@example.com"));
    let input = crate::administration::RecoverEmail {
        actor_id: f.actor.user_id.clone(),
        user_id: f.actor.user_id.clone(),
        email: "recovered@example.com".into(),
        expected_revision: 1,
        confirm: true,
    };
    crate::administration::recover_email(&f.db, input)
        .await
        .unwrap();
    assert!(verify(&otp, &c, &code, &nonce).await.is_err());
    f.db.read(move |tx| {
        assert!(security::fresh(tx, &f.actor).is_err());
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn schema_nine_upgrade_preserves_legacy_password_hash_sessions_and_grants() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("else.sqlite3");
    let conn = crate::db::connection(&path).unwrap();
    conn.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT;").unwrap();
    for (index, sql) in [
        include_str!("../../../migrations/sqlite/000001_initial.sql"),
        include_str!("../../../migrations/sqlite/000002_runtime_cleanup.sql"),
        include_str!("../../../migrations/sqlite/000003_operations.sql"),
        include_str!("../../../migrations/sqlite/000004_commercial_finance.sql"),
        include_str!("../../../migrations/sqlite/000005_recurring_operations.sql"),
        include_str!("../../../migrations/sqlite/000006_dashboard_attention_indexes.sql"),
        include_str!("../../../migrations/sqlite/000007_session_refresh.sql"),
        include_str!("../../../migrations/sqlite/000008_mcp_bridge.sql"),
        include_str!("../../../migrations/sqlite/000009_financial_intelligence.sql"),
    ]
    .iter()
    .enumerate()
    {
        conn.execute_batch(sql).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations VALUES (?1,?2,?3)",
            params![
                (index + 1) as i64,
                crate::db::migration_records()[index].1,
                validation::now()
            ],
        )
        .unwrap();
    }
    let id = validation::new_id();
    let session = validation::new_id();
    let (token, hash) = secret();
    let (_, csrf) = secret();
    let now = validation::now();
    conn.execute("INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES (?1,'legacy@example.com','Legacy fixture','retained-inert-legacy-hash','active',?2,?2)",params![id,now]).unwrap();
    let role = validation::new_id();
    conn.execute(
        "INSERT INTO permissions VALUES ('clients.view','client','View client profiles')",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO roles(id,role_key,display_name,created_at,updated_at) VALUES (?1,'legacy_custom','Legacy role',?2,?2)",params![role,now]).unwrap();
    conn.execute("INSERT INTO role_permissions(id,role_id,permission_key,assigned_at) VALUES (?1,?2,'clients.view',?3)",params![validation::new_id(),role,now]).unwrap();
    conn.execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,assigned_at) VALUES (?1,?2,?3,'global',?4)",params![validation::new_id(),id,role,now]).unwrap();
    conn.execute(
        "INSERT INTO sessions VALUES (?1,?2,?3,?4,?5,?6,NULL)",
        params![
            session,
            id,
            hash,
            csrf,
            now,
            (Utc::now() + Duration::hours(12)).to_rfc3339_opts(SecondsFormat::Micros, true)
        ],
    )
    .unwrap();
    drop(conn);
    let db = Database::open(&path, true).unwrap();
    let auth = Auth::new(db.clone()).unwrap();
    let legacy = auth.current(&token, audit::request_id()).await.unwrap();
    assert_eq!(legacy.user.id, id);
    assert_eq!(legacy.actor.session_id, session);
    assert!(
        legacy
            .user
            .permissions
            .iter()
            .any(|grant| grant.permission == "clients.view" && grant.scope == "global")
    );
    let conn = crate::db::connection(&path).unwrap();
    assert_eq!(
        conn.query_row::<String, _, _>("SELECT password_hash FROM users WHERE id=?1", [id], |r| r
            .get(0))
            .unwrap(),
        "retained-inert-legacy-hash"
    );
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT count(*) FROM session_refresh_tokens", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn verification_peer_and_global_budgets_survive_database_reopen() {
    let f = Fixture::new().await;
    let otp = service(&f);
    let nonce = secret().0;
    let challenge = Challenge {
        challenge_id: secret().0,
        expires_in: 180,
        resend_after: 60,
    };
    for _ in 0..100 {
        assert_eq!(
            verify(&otp, &challenge, "000000", &nonce)
                .await
                .err()
                .unwrap()
                .status(),
            http::StatusCode::UNAUTHORIZED
        );
    }
    let mut restarted = service(&f);
    restarted.db = Database::open(&f.directory.path().join("else.sqlite3"), true).unwrap();
    assert_eq!(
        verify(&restarted, &challenge, "000000", &nonce)
            .await
            .err()
            .unwrap()
            .status(),
        http::StatusCode::TOO_MANY_REQUESTS
    );
    let connection = f.connection();
    connection
        .execute("DELETE FROM auth_otp_rate_events", [])
        .unwrap();
    connection.execute("WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n<1000) INSERT INTO auth_otp_rate_events(kind,subject,occurred_at) SELECT 'verify_global',?1,?2 FROM slots",params![subject("verify_global","all"),Utc::now().timestamp()]).unwrap();
    assert_eq!(
        verify(&restarted, &challenge, "000000", &nonce)
            .await
            .err()
            .unwrap()
            .status(),
        http::StatusCode::TOO_MANY_REQUESTS
    );
}
#[tokio::test]
async fn mail_queue_admission_is_bounded_for_known_and_unknown_targets() {
    let f = Fixture::new().await;
    let mut otp = service(&f);
    otp.policy.peer_requests = 300;
    let nonce = secret().0;
    let connection = f.connection();
    for index in 0..100 {
        let email = format!("queue-{index}@example.com");
        connection.execute("INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES (?1,?2,'Synthetic queue account','!passwordless','active',?3,?3)",params![validation::new_id(),email,validation::now()]).unwrap();
        issue(&otp, &email, &nonce).await;
    }
    assert_eq!(
        connection
            .query_row::<i64, _, _>(
                "SELECT count(*) FROM auth_email_outbox WHERE state='queued'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        100
    );
    for email in ["admin@example.com", "missing@example.com"] {
        assert_eq!(
            otp.request(
                RequestCode {
                    email: email.into()
                },
                "fixture-peer".into(),
                &nonce
            )
            .await
            .err()
            .unwrap()
            .status(),
            http::StatusCode::SERVICE_UNAVAILABLE
        );
    }
    assert_eq!(
        connection
            .query_row::<i64, _, _>("SELECT count(*) FROM auth_otp_challenges", [], |r| r.get(0))
            .unwrap(),
        100
    );
}

#[test]
fn identity_email_syntax_matches_the_smtp_boundary_without_changing_legacy_data() {
    for invalid in [
        "@example.com",
        ".start@example.com",
        "end.@example.com",
        "double..dot@example.com",
        "missing-domain",
        "a@bad..example.com",
    ] {
        assert!(
            super::super::email(invalid).is_err(),
            "invalid address accepted: {invalid}"
        );
    }
    assert!(super::super::email(&format!("{}@example.com", "x".repeat(65))).is_err());
    assert_eq!(
        super::super::email("  Member+Tag@Example.com  ").unwrap(),
        "member+tag@example.com"
    );
}
