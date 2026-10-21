use super::*;
use crate::{credentials::Keyring, testing::Fixture};
use base64::Engine;
fn otp(f: &Fixture) -> Otp {
    let ring=Keyring::parse(&serde_json::to_vec(&serde_json::json!({"active_key_id":"mail-fixture","keys":[{"id":"mail-fixture","key_base64":base64::engine::general_purpose::STANDARD.encode([84u8;32])}]})).unwrap()).unwrap();
    Otp {
        db: f.db.clone(),
        ring,
        policy: Default::default(),
        enabled: true,
    }
}
fn settings() -> BTreeMap<String, String> {
    [
        ("SMTP_HOST", "smtp.example.com"),
        ("SMTP_FROM_ADDRESS", "signin@example.com"),
        ("SMTP_USERNAME", "synthetic-user"),
        ("SMTP_PASSWORD", "synthetic-only-secret"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}
fn relay_settings() -> BTreeMap<String, String> {
    let mut values = settings();
    values.remove("SMTP_USERNAME");
    values.remove("SMTP_PASSWORD");
    values.insert("SMTP_AUTH_MODE".into(), "trusted_relay".into());
    values.insert("SMTP_RELAY_IP".into(), "10.203.41.2".into());
    values.insert("SMTP_PORT".into(), "10025".into());
    values
}
#[test]
fn trusted_relay_is_explicit_pinned_private_encrypted_and_credential_free() {
    for security in ["starttls", "tls"] {
        let mut values = relay_settings();
        values.insert("SMTP_SECURITY".into(), security.into());
        let config = MailConfig::parse(false, &values).unwrap().unwrap();
        assert_eq!(config.relay, Some("10.203.41.2".parse().unwrap()));
        assert!(config.username.is_none() && config.password.is_none());
    }
    for (field, value) in [
        ("SMTP_AUTH_MODE", "anonymous"),
        ("SMTP_AUTH_MODE", ""),
        ("SMTP_RELAY_IP", ""),
        ("SMTP_PORT", ""),
        ("SMTP_RELAY_IP", "8.8.8.8"),
        ("SMTP_RELAY_IP", "127.0.0.1"),
        ("SMTP_RELAY_IP", "169.254.169.254"),
        ("SMTP_RELAY_IP", "100.64.0.1"),
        ("SMTP_RELAY_IP", "10.1.1.0/24"),
        ("SMTP_RELAY_IP", "::ffff:10.1.1.1"),
        ("SMTP_HOST", "10.203.41.2"),
        ("SMTP_HOST", "localhost"),
        ("SMTP_HOST", "-mail.example.com"),
        ("SMTP_HOST", "mail..example.com"),
        ("SMTP_SECURITY", "none"),
        ("SMTP_SECURITY", "opportunistic"),
        ("SMTP_USERNAME", "unexpected"),
        ("SMTP_PASSWORD", "unexpected"),
        ("SMTP_PASSWORD_FILE", "/synthetic-unread-secret"),
    ] {
        let mut values = relay_settings();
        values.insert(field.into(), value.into());
        assert!(MailConfig::parse(false, &values).is_err(), "field {field}");
    }
    let mut values = settings();
    values.insert("SMTP_RELAY_IP".into(), "10.203.41.2".into());
    assert!(MailConfig::parse(false, &values).is_err());
    for field in ["SMTP_HOST", "SMTP_FROM_ADDRESS"] {
        let mut values = relay_settings();
        values.remove(field);
        assert!(MailConfig::parse(false, &values).is_err());
    }
}
fn local(port: u16) -> MailConfig {
    MailConfig {
        host: "127.0.0.1".into(),
        port,
        username: None,
        password: None,
        from: "signin@example.com".into(),
        name: "Roisey Else".into(),
        security: "none".into(),
        timeout: 1,
        relay: None,
        roots: Vec::new(),
    }
}

mod tls;
#[test]
fn configuration_rejects_plaintext_downgrades_invalid_sender_and_unsafe_secrets() {
    assert!(
        MailConfig::parse(false, &BTreeMap::new())
            .unwrap()
            .is_none()
    );
    assert!(MailConfig::parse(false, &settings()).unwrap().is_some());
    for (key, value) in [
        ("SMTP_SECURITY", "none"),
        ("SMTP_SECURITY", "opportunistic"),
        ("SMTP_PORT", "0"),
        ("SMTP_HOST", "smtp.example.com/path"),
        ("SMTP_FROM_ADDRESS", "injected\r\nBcc: attacker@example.com"),
        ("SMTP_TIMEOUT_SECONDS", "99"),
        ("SMTP_USERNAME", ""),
        ("SMTP_PASSWORD_FILE", "relative-path"),
    ] {
        let mut input = settings();
        input.insert(key.into(), value.into());
        assert!(
            MailConfig::parse(false, &input).is_err(),
            "configuration field {key}"
        );
    }
    let mut fixture = settings();
    fixture.insert("SMTP_HOST".into(), "127.0.0.1".into());
    fixture.insert("SMTP_SECURITY".into(), "none".into());
    fixture.remove("SMTP_USERNAME");
    fixture.remove("SMTP_PASSWORD");
    assert!(MailConfig::parse(true, &fixture).unwrap().is_some());
    assert!(MailConfig::parse(false, &fixture).is_err());
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("smtp-password");
    std::fs::write(&path, b"synthetic-only-secret\n").unwrap();
    let mut input = settings();
    input.remove("SMTP_PASSWORD");
    input.insert("SMTP_PASSWORD_FILE".into(), path.to_str().unwrap().into());
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(MailConfig::parse(false, &input).is_err());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
    assert!(MailConfig::parse(false, &input).unwrap().is_some());
}
#[test]
fn all_localized_templates_are_multipart_safe_and_keep_leading_zeroes() {
    for locale in ["en", "tr", "ro", "de", "fr", "unknown"] {
        let payload = Payload {
            email: "only-recipient@example.com".into(),
            code: "000042".into(),
            locale: locale.into(),
            seconds: 180,
        };
        let value = message(&local(2525), &payload).unwrap();
        assert_eq!(value.envelope().to().len(), 1);
        assert_eq!(value.envelope().to()[0].to_string(), payload.email);
        let raw = String::from_utf8(value.formatted()).unwrap();
        assert!(raw.contains("multipart/alternative"));
        assert!(raw.contains("000042"));
        assert!(!raw.contains("<script"));
        assert!(!raw.contains("<img"));
        assert!(!raw.contains("https://"));
    }
    assert!(
        message(
            &local(2525),
            &Payload {
                email: "a@example.com".into(),
                code: "<html>".into(),
                locale: "en".into(),
                seconds: 180
            }
        )
        .is_err()
    );
}
#[tokio::test]
async fn delivery_failures_and_abandoned_claims_erase_material_and_never_authenticate() {
    let f = Fixture::new().await;
    let otp = otp(&f);
    let nonce = secret().0;
    let challenge = otp
        .request(
            otp::RequestCode {
                email: "admin@example.com".into(),
            },
            "mail-peer".into(),
            &nonce,
        )
        .await
        .unwrap();
    let port = {
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        socket.local_addr().unwrap().port()
    };
    let worker = Worker::new(otp.clone(), local(port)).unwrap();
    assert!(worker.run_once().await.unwrap());
    assert!(!worker.run_once().await.unwrap());
    let row: (String, Option<Vec<u8>>) = f
        .connection()
        .query_row(
            "SELECT state,envelope FROM auth_email_outbox WHERE challenge_id=?1",
            [&challenge.challenge_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("failed".into(), None));
    assert!(
        otp.verify(
            otp::VerifyCode {
                challenge_id: challenge.challenge_id,
                code: "000000".into()
            },
            "mail-peer".into(),
            &nonce,
            audit::request_id()
        )
        .await
        .is_err()
    );
    f.connection()
        .execute("DELETE FROM auth_otp_rate_events", [])
        .unwrap();
    let challenge = otp
        .request(
            otp::RequestCode {
                email: "admin@example.com".into(),
            },
            "mail-peer".into(),
            &nonce,
        )
        .await
        .unwrap();
    f.connection()
        .execute(
            "UPDATE auth_otp_challenges SET state='sending' WHERE id=?1",
            [&challenge.challenge_id],
        )
        .unwrap();
    f.connection()
        .execute(
            "UPDATE auth_email_outbox SET state='sending' WHERE challenge_id=?1",
            [&challenge.challenge_id],
        )
        .unwrap();
    worker.recover().await.unwrap();
    assert!(!worker.run_once().await.unwrap());
    assert_eq!(
        f.connection()
            .query_row::<String, _, _>(
                "SELECT state FROM auth_otp_challenges WHERE id=?1",
                [challenge.challenge_id],
                |r| r.get(0)
            )
            .unwrap(),
        "invalidated"
    );
}
#[tokio::test]
async fn expired_queue_entries_and_corrupt_payloads_are_suppressed_without_blocking_queue() {
    let f = Fixture::new().await;
    let otp = otp(&f);
    let nonce = secret().0;
    let worker = Worker::new(otp.clone(), local(2525)).unwrap();
    let first = otp
        .request(
            otp::RequestCode {
                email: "admin@example.com".into(),
            },
            "mail-peer".into(),
            &nonce,
        )
        .await
        .unwrap();
    f.connection()
        .execute(
            "UPDATE auth_email_outbox SET deadline=?1 WHERE challenge_id=?2",
            params![Utc::now().timestamp(), first.challenge_id],
        )
        .unwrap();
    assert!(!worker.run_once().await.unwrap());
    f.connection()
        .execute("DELETE FROM auth_otp_rate_events", [])
        .unwrap();
    let next = otp
        .request(
            otp::RequestCode {
                email: "admin@example.com".into(),
            },
            "mail-peer".into(),
            &nonce,
        )
        .await
        .unwrap();
    f.connection()
        .execute(
            "UPDATE auth_email_outbox SET envelope=zeroblob(40) WHERE challenge_id=?1",
            [next.challenge_id],
        )
        .unwrap();
    assert!(!worker.run_once().await.unwrap());
    assert_eq!(
        f.connection()
            .query_row::<i64, _, _>(
                "SELECT count(*) FROM auth_email_outbox WHERE envelope IS NOT NULL",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        0
    );
}
