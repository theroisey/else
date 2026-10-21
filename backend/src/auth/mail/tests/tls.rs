use super::*;
use lettre::transport::smtp::client::Certificate;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::{process::Command, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

fn certificate() -> (Certificate, Arc<rustls::ServerConfig>) {
    let directory = tempfile::tempdir().unwrap();
    let cert = directory.path().join("cert.der");
    let pem = directory.path().join("key.pem");
    let key = directory.path().join("key.der");
    let generated = Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-noenc",
            "-sha256",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost",
            "-addext",
            "basicConstraints=critical,CA:FALSE",
            "-addext",
            "extendedKeyUsage=serverAuth",
            "-outform",
            "DER",
            "-out",
        ])
        .arg(&cert)
        .arg("-keyout")
        .arg(&pem)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "isolated certificate generation failed"
    );
    let converted = Command::new("openssl")
        .args(["pkcs8", "-topk8", "-nocrypt", "-in"])
        .arg(&pem)
        .args(["-outform", "DER", "-out"])
        .arg(&key)
        .output()
        .unwrap();
    assert!(converted.status.success());
    let bytes = std::fs::read(cert).unwrap();
    let trusted = Certificate::from_der(bytes.clone()).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(bytes)],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(std::fs::read(key).unwrap())),
    )
    .unwrap();
    (trusted, Arc::new(config))
}

enum Behavior {
    Deliver,
    NoStartTls,
    Stall,
    LostHandoff,
}
async fn sink(
    config: Arc<rustls::ServerConfig>,
    behavior: Behavior,
) -> (u16, tokio::task::JoinHandle<(bool, bool)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut plain = BufReader::new(stream);
        plain
            .get_mut()
            .write_all(b"220 synthetic.relay.test ESMTP\r\n")
            .await
            .unwrap();
        let mut line = String::new();
        if plain.read_line(&mut line).await.unwrap_or(0) == 0 {
            return (false, false);
        }
        assert!(line.starts_with("EHLO "));
        if matches!(behavior, Behavior::NoStartTls) {
            plain
                .get_mut()
                .write_all(b"250 synthetic.relay.test\r\n")
                .await
                .unwrap();
            line.clear();
            let _ = plain.read_line(&mut line).await;
            assert!(!line.starts_with("MAIL "));
            return (false, false);
        }
        plain
            .get_mut()
            .write_all(b"250-synthetic.relay.test\r\n250 STARTTLS\r\n")
            .await
            .unwrap();
        line.clear();
        plain.read_line(&mut line).await.unwrap();
        assert_eq!(line, "STARTTLS\r\n");
        plain
            .get_mut()
            .write_all(b"220 Begin TLS\r\n")
            .await
            .unwrap();
        let Ok(stream) = tokio_rustls::TlsAcceptor::from(config)
            .accept(plain.into_inner())
            .await
        else {
            return (false, false);
        };
        let mut stream = BufReader::new(stream);
        let mut authenticated = false;
        let mut delivered = false;
        let mut data = false;
        loop {
            line.clear();
            if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                break;
            }
            let response: &[u8] = if data {
                if line == ".\r\n" {
                    if matches!(behavior, Behavior::LostHandoff) {
                        break;
                    }
                    delivered = true;
                    data = false;
                    b"250 accepted by fixture only\r\n"
                } else {
                    continue;
                }
            } else if line.starts_with("EHLO ") {
                if matches!(behavior, Behavior::Stall) {
                    std::future::pending::<()>().await;
                }
                b"250-synthetic.relay.test\r\n250 AUTH PLAIN\r\n"
            } else if line.starts_with("AUTH ") {
                authenticated = true;
                b"235 authenticated\r\n"
            } else if line.starts_with("MAIL FROM:") || line.starts_with("RCPT TO:") {
                b"250 OK\r\n"
            } else if line == "DATA\r\n" {
                data = true;
                b"354 send message\r\n"
            } else if line == "QUIT\r\n" {
                let _ = stream.get_mut().write_all(b"221 bye\r\n").await;
                break;
            } else {
                b"250 OK\r\n"
            };
            if stream.get_mut().write_all(response).await.is_err() {
                break;
            }
        }
        (authenticated, delivered)
    });
    (port, task)
}
fn tls_config(port: u16, root: &Certificate) -> MailConfig {
    let mut config = local(port);
    config.host = "localhost".into();
    config.security = "starttls".into();
    // Test-only loopback substitution; public parse rejects loopback relay IPs.
    config.relay = Some(Ipv4Addr::LOCALHOST);
    config.roots.push(root.clone());
    config
}
fn sample(config: &MailConfig) -> Message {
    message(
        config,
        &Payload {
            email: "fixture@example.test".into(),
            code: "000042".into(),
            locale: "en".into(),
            seconds: 180,
        },
    )
    .unwrap()
}
#[tokio::test]
async fn verified_starttls_omits_auth_even_when_advertised_and_credentials_still_authenticate() {
    let (root, cert) = certificate();
    let (port, task) = sink(cert.clone(), Behavior::Deliver).await;
    let config = tls_config(port, &root);
    config
        .transport()
        .unwrap()
        .send(sample(&config))
        .await
        .unwrap();
    assert_eq!(task.await.unwrap(), (false, true));
    let (port, task) = sink(cert, Behavior::Deliver).await;
    let mut config = tls_config(port, &root);
    config.relay = None;
    config.username = Some("synthetic-user".into());
    config.password = Some(Zeroizing::new("synthetic-password".into()));
    config
        .transport()
        .unwrap()
        .send(sample(&config))
        .await
        .unwrap();
    assert_eq!(task.await.unwrap(), (true, true));
}
#[tokio::test]
async fn certificate_hostname_and_starttls_downgrade_fail_closed() {
    let (root, cert) = certificate();
    for failure in ["untrusted", "hostname", "downgrade"] {
        let (port, task) = sink(
            cert.clone(),
            if failure == "downgrade" {
                Behavior::NoStartTls
            } else {
                Behavior::Deliver
            },
        )
        .await;
        let mut config = tls_config(port, &root);
        if failure == "untrusted" {
            config.roots.clear();
        }
        if failure == "hostname" {
            config.host = "wrong.example.test".into();
        }
        assert!(
            config
                .transport()
                .unwrap()
                .send(sample(&config))
                .await
                .is_err(),
            "{failure}"
        );
        assert_eq!(task.await.unwrap(), (false, false));
    }
}
#[tokio::test]
async fn tls_timeout_and_lost_handoff_invalidate_codes_without_sessions_or_retry() {
    let (root, cert) = certificate();
    for behavior in [Behavior::Stall, Behavior::LostHandoff] {
        let (port, task) = sink(cert.clone(), behavior).await;
        let f = Fixture::new().await;
        let sessions_before: i64 = f
            .connection()
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        let otp = otp(&f);
        let nonce = secret().0;
        let challenge = otp
            .request(
                otp::RequestCode {
                    email: "admin@example.com".into(),
                },
                "tls-peer".into(),
                &nonce,
            )
            .await
            .unwrap();
        let worker = Worker::new(otp.clone(), tls_config(port, &root)).unwrap();
        let started = std::time::Instant::now();
        assert!(worker.run_once().await.unwrap());
        assert!(started.elapsed() < StdDuration::from_secs(4));
        assert!(!worker.run_once().await.unwrap());
        assert_eq!(
            f.connection()
                .query_row::<i64, _, _>("SELECT count(*) FROM sessions", [], |r| r.get(0))
                .unwrap(),
            sessions_before
        );
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
        task.abort();
    }
}
