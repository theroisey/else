//! Bounded HTTP client only. Pingora remains the sole application HTTP server.
//! DNS is revalidated and pinned for each call; no proxy, redirect, cookie,
//! decompression, connection pool or automatic retry path exists.
use crate::{
    error::{Error, Result},
    integration_catalog, provider_json,
};
use bytes::Bytes;
use http::{HeaderMap, Method, Request};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use std::{
    collections::BTreeSet,
    fmt,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_rustls::TlsConnector;
use url::Url;
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct Transport {
    tls: Arc<ClientConfig>,
    slots: Arc<Semaphore>,
}
pub struct Client {
    transport: Transport,
    origin: Url,
    #[cfg(test)]
    pinned: Option<SocketAddr>,
}
impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[private provider HTTPS client]")
    }
}
pub enum Policy {
    Report,
    Metadata,
}
pub struct Call<'a> {
    pub method: Method,
    pub path: &'a str,
    pub query: &'a [(&'a str, &'a str)],
    pub body: &'a [u8],
    pub authorization: &'a str,
    pub content_type: Option<&'a str>,
    pub policy: Policy,
    pub commerce_page: bool,
}
pub struct Page {
    pub raw: Zeroizing<Vec<u8>>,
    pub json: serde_json::Value,
    pub total: Option<usize>,
    pub pages: Option<usize>,
}
impl fmt::Debug for Page {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[private provider response]")
    }
}
struct Driver(JoinHandle<()>);
impl Drop for Driver {
    fn drop(&mut self) {
        self.0.abort();
    }
}
const QUERY_KEYS: &[&str] = &[
    "after",
    "before",
    "page",
    "per_page",
    "orderby",
    "order",
    "_fields",
    "dp",
    "dates_are_gmt",
    "include",
    "fields",
    "time_increment",
    "time_range",
    "level",
    "limit",
    "offset",
];

impl Transport {
    pub fn new() -> Result<Self> {
        let mut roots = RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            roots.add(cert).map_err(|_| Error::Internal)?;
        }
        if roots.is_empty() {
            return Err(Error::Internal);
        }
        let tls =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
                .map_err(|_| Error::Internal)?
                .with_root_certificates(roots)
                .with_no_client_auth();
        Ok(Self {
            tls: Arc::new(tls),
            slots: Arc::new(Semaphore::new(2)),
        })
    }
    pub fn client(&self, origin: &str) -> Result<Client> {
        if !integration_catalog::store(origin) {
            return Err(Error::Internal);
        }
        let origin = Url::parse(origin).map_err(|_| Error::Internal)?;
        if origin
            .host_str()
            .and_then(|h| h.rsplit('.').next())
            .is_none_or(|tld| tld.len() < 2)
        {
            return Err(Error::Internal);
        }
        Ok(Client {
            transport: self.clone(),
            origin,
            #[cfg(test)]
            pinned: None,
        })
    }
}
impl Client {
    pub async fn call(&self, call: Call<'_>) -> Result<Page> {
        validate(&call)?;
        let permit = Arc::new(
            self.transport
                .slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| Error::Busy)?,
        );
        timeout(Duration::from_secs(10), self.request(call, permit))
            .await
            .map_err(|_| Error::Internal)?
    }
    async fn addresses(
        &self,
        deadline: Instant,
        permit: Arc<OwnedSemaphorePermit>,
    ) -> Result<Vec<SocketAddr>> {
        #[cfg(test)]
        if let Some(address) = self.pinned {
            return Ok(vec![address]);
        }
        let host = self.origin.host_str().ok_or(Error::Internal)?.to_owned();
        // A cancelled getaddrinfo call may keep blocking in the OS. It owns its
        // admission permit until it actually stops, preserving the two-call cap.
        let work = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let answers: Vec<_> = (host.as_str(), 443)
                .to_socket_addrs()
                .map_err(|_| Error::Internal)?
                .take(9)
                .collect();
            if answers.is_empty()
                || answers.len() > 8
                || answers.iter().any(|addr| !public_address(*addr))
            {
                return Err(Error::Internal);
            }
            Ok(answers)
        });
        timeout_at(deadline, work)
            .await
            .map_err(|_| Error::Internal)?
            .map_err(|_| Error::Internal)?
    }
    async fn request(&self, call: Call<'_>, permit: Arc<OwnedSemaphorePermit>) -> Result<Page> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let addresses = self.addresses(deadline, permit.clone()).await?;
        let connection = timeout_at(deadline, async {
            for address in addresses {
                if let Ok(stream) = TcpStream::connect(address).await {
                    return Ok(stream);
                }
            }
            Err(Error::Internal)
        })
        .await
        .map_err(|_| Error::Internal)??;
        connection.set_nodelay(true).map_err(|_| Error::Internal)?;
        let hostname =
            ServerName::try_from(self.origin.host_str().ok_or(Error::Internal)?.to_owned())
                .map_err(|_| Error::Internal)?;
        let secured = timeout(
            Duration::from_secs(3),
            TlsConnector::from(self.transport.tls.clone()).connect(hostname, connection),
        )
        .await
        .map_err(|_| Error::Internal)?
        .map_err(|_| Error::Internal)?;
        let mut builder = hyper::client::conn::http1::Builder::new();
        builder.max_buf_size(16_384).max_headers(128);
        let (mut sender, driver) = builder
            .handshake::<_, Full<Bytes>>(TokioIo::new(secured))
            .await
            .map_err(|_| Error::Internal)?;
        let driver_permit = permit.clone();
        let _driver = Driver(tokio::spawn(async move {
            let _permit = driver_permit;
            let _ = driver.await;
        }));
        let mut path = format!("{}{}", self.origin.path().trim_end_matches('/'), call.path);
        if !call.query.is_empty() {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(call.query.iter().copied())
                .finish();
            if query.len() > 4096 {
                return Err(Error::Internal);
            }
            path.push('?');
            path.push_str(&query);
        }
        let host = match self.origin.port() {
            Some(port) => format!("{}:{port}", self.origin.host_str().ok_or(Error::Internal)?),
            None => self.origin.host_str().ok_or(Error::Internal)?.into(),
        };
        let mut request = Request::builder()
            .method(call.method)
            .uri(path)
            .header("host", host)
            .header("accept", "application/json")
            .header("connection", "close");
        if !call.authorization.is_empty() {
            request = request.header("authorization", call.authorization);
        }
        if let Some(content_type) = call.content_type {
            request = request.header("content-type", content_type);
        }
        let request = request
            .body(Full::new(Bytes::copy_from_slice(call.body)))
            .map_err(|_| Error::Internal)?;
        let response = timeout(Duration::from_secs(4), sender.send_request(request))
            .await
            .map_err(|_| Error::Internal)?
            .map_err(|_| Error::Internal)?;
        let headers = response.headers();
        if response.status() != 200
            || headers
                .iter()
                .map(|(key, value)| key.as_str().len() + value.len() + 4)
                .sum::<usize>()
                > 16_384
            || headers.contains_key("content-encoding")
        {
            return Err(Error::Internal);
        }
        let content = single(headers, "content-type")?
            .parse::<mime::Mime>()
            .map_err(|_| Error::Internal)?;
        if content.essence_str() != "application/json" {
            return Err(Error::Internal);
        }
        let max = match call.policy {
            Policy::Report => 65_536,
            Policy::Metadata => 262_144,
        };
        let (total, pages) = if call.commerce_page {
            (
                Some(page_count(headers, "x-wp-total", 500)?),
                Some(page_count(headers, "x-wp-totalpages", 5)?),
            )
        } else {
            (None, None)
        };
        if headers.get("content-length").is_some_and(|raw| {
            raw.to_str()
                .ok()
                .and_then(|s| s.parse::<usize>().ok())
                .is_none_or(|size| size > max)
        }) {
            return Err(Error::Internal);
        }
        let mut body = response.into_body();
        let mut raw = Zeroizing::new(Vec::new());
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| Error::Internal)?;
            let bytes = frame.into_data().map_err(|_| Error::Internal)?;
            if bytes.len() > max - raw.len() {
                return Err(Error::Internal);
            }
            raw.extend_from_slice(&bytes);
        }
        if raw.is_empty() {
            return Err(Error::Internal);
        }
        let json = provider_json::parse(&raw)?;
        Ok(Page {
            raw,
            json,
            total,
            pages,
        })
    }
}
fn single<'a>(headers: &'a HeaderMap, key: &str) -> Result<&'a str> {
    let mut entries = headers.get_all(key).iter();
    let first = entries
        .next()
        .ok_or(Error::Internal)?
        .to_str()
        .map_err(|_| Error::Internal)?;
    if entries.next().is_some() {
        return Err(Error::Internal);
    }
    Ok(first)
}
fn page_count(headers: &HeaderMap, key: &str, max: usize) -> Result<usize> {
    let raw = single(headers, key)?;
    if raw.is_empty()
        || (raw.len() > 1 && raw.starts_with('0'))
        || !raw.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::Internal);
    }
    let value = raw.parse::<usize>().map_err(|_| Error::Internal)?;
    if value > max {
        return Err(Error::Internal);
    }
    Ok(value)
}
fn validate(call: &Call<'_>) -> Result<()> {
    if !matches!(call.method, Method::GET | Method::POST)
        || call.body.len() > 16_384
        || (call.method == Method::GET && !call.body.is_empty())
        || call.authorization.len() > 4096
        || call.authorization.contains(['\r', '\n'])
        || (!call.authorization.is_empty()
            && !call.authorization.starts_with("Bearer ")
            && !call.authorization.starts_with("Basic "))
        || !call.path.starts_with('/')
        || call.path.starts_with("//")
        || call.path.len() > 512
        || !call
            .path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_/.:".contains(&b))
        || call.path.split('/').any(|part| matches!(part, "." | ".."))
        || call
            .content_type
            .is_some_and(|t| !matches!(t, "application/json" | "application/x-www-form-urlencoded"))
        || (call.commerce_page
            && (call.method != Method::GET || matches!(call.policy, Policy::Metadata)))
    {
        return Err(Error::Internal);
    }
    let mut seen = BTreeSet::new();
    for (key, value) in call.query {
        if !QUERY_KEYS.contains(key) || !seen.insert(*key) || value.is_empty() || value.len() > 2048
        {
            return Err(Error::Internal);
        }
    }
    Ok(())
}
pub fn public_address(address: SocketAddr) -> bool {
    if matches!(address,SocketAddr::V6(ref a) if a.scope_id()!=0) {
        return false;
    }
    let mut ip = address.ip();
    if let IpAddr::V6(v6) = ip
        && let Some(v4) = v6.to_ipv4_mapped()
    {
        ip = IpAddr::V4(v4);
    }
    match ip {
        IpAddr::V4(ip) => {
            let value = u32::from(ip);
            ![
                (0, 8),
                (0x0a000000, 8),
                (0x64400000, 10),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0xac100000, 12),
                (0xc0000000, 24),
                (0xc0000200, 24),
                (0xc0586300, 24),
                (0xc0a80000, 16),
                (0xc6120000, 15),
                (0xc6336400, 24),
                (0xcb007100, 24),
                (0xe0000000, 4),
                (0xf0000000, 4),
            ]
            .iter()
            .any(|(prefix, bits)| value & (u32::MAX << (32 - bits)) == *prefix)
        }
        IpAddr::V6(ip) => {
            let value = u128::from(ip);
            value >> (128 - 3) == 1
                && value >> (128 - 23) != (0x20010000000000000000000000000000u128 >> (128 - 23))
                && value >> (128 - 32) != (0x20010db8000000000000000000000000u128 >> (128 - 32))
                && value >> (128 - 16) != 0x2002
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_special_mapped_and_scoped_destinations_are_refused() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2002::1",
        ] {
            assert!(
                !public_address(SocketAddr::new(ip.parse().unwrap(), 443)),
                "{ip}"
            );
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(
                public_address(SocketAddr::new(ip.parse().unwrap(), 443)),
                "{ip}"
            );
        }
    }

    fn tls_fixture() -> (Arc<ClientConfig>, Arc<rustls::ServerConfig>) {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        use std::process::Command;
        let directory = tempfile::tempdir().unwrap();
        let cert = directory.path().join("synthetic-cert.der");
        let pem = directory.path().join("synthetic-key.pem");
        let key = directory.path().join("synthetic-key.der");
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
                "keyUsage=critical,digitalSignature,keyEncipherment",
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
            .expect("OpenSSL is required for isolated TLS tests");
        assert!(
            generated.status.success(),
            "synthetic TLS certificate generation failed"
        );
        let converted = Command::new("openssl")
            .args(["pkcs8", "-topk8", "-nocrypt", "-in"])
            .arg(&pem)
            .arg("-outform")
            .arg("DER")
            .arg("-out")
            .arg(&key)
            .output()
            .unwrap();
        assert!(converted.status.success());
        let certificate = CertificateDer::from(std::fs::read(&cert).unwrap());
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(std::fs::read(&key).unwrap()));
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut roots = RootCertStore::empty();
        roots.add(certificate.clone()).unwrap();
        let client = ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let server = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)
            .unwrap();
        (Arc::new(client), Arc::new(server))
    }
    async fn fixture(
        response: Vec<u8>,
        tls: Arc<ClientConfig>,
        server: Arc<rustls::ServerConfig>,
    ) -> (Client, JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut stream) = tokio_rustls::TlsAcceptor::from(server).accept(stream).await
            else {
                return;
            };
            let mut headers = Vec::new();
            let mut byte = [0u8; 1];
            while headers.len() < 16_384 {
                if stream.read_exact(&mut byte).await.is_err() {
                    return;
                }
                headers.push(byte[0]);
                if headers.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let _ = stream.write_all(&response).await;
            let _ = stream.shutdown().await;
        });
        let client = Client {
            transport: Transport {
                tls,
                slots: Arc::new(Semaphore::new(2)),
            },
            origin: Url::parse(&format!("https://localhost:{}", address.port())).unwrap(),
            pinned: Some(address),
        };
        (client, server)
    }
    fn call(commerce_page: bool) -> Call<'static> {
        Call {
            method: Method::GET,
            path: "/synthetic",
            query: &[],
            body: &[],
            authorization: "Bearer synthetic-only-token",
            content_type: None,
            policy: Policy::Report,
            commerce_page,
        }
    }
    #[tokio::test]
    async fn actual_tls_and_http_boundaries_reject_redirects_expansion_and_ambiguous_pages() {
        let (tls, server) = tls_fixture();
        let good=b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 7\r\nConnection: close\r\n\r\n{\"x\":1}".to_vec();
        let (client, task) = fixture(good, tls.clone(), server.clone()).await;
        assert_eq!(client.call(call(false)).await.unwrap().json["x"], 1);
        task.await.unwrap();
        for response in [
            b"HTTP/1.1 302 Found\r\nLocation: https://example.com\r\nContent-Length: 0\r\n\r\n".to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Expanded: {}\r\nContent-Length: 2\r\n\r\n{{}}","x".repeat(20_000)).into_bytes(),
        ] {
            let (client,task)=fixture(response,tls.clone(),server.clone()).await;assert!(client.call(call(false)).await.is_err());task.await.unwrap();
        }
        let json = format!("{{\"padding\":\"{}\"}}", "x".repeat(65_536));
        let oversized=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{json}\r\n0\r\n\r\n",json.len()).into_bytes();
        let (client, task) = fixture(oversized, tls.clone(), server.clone()).await;
        assert!(client.call(call(false)).await.is_err());
        task.await.unwrap();
        for total in ["0", "01", "501", "0\r\nX-WP-Total: 0"] {
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-WP-Total: {total}\r\nX-WP-TotalPages: 0\r\nContent-Length: 2\r\n\r\n[]").into_bytes();
            let (client, task) = fixture(response, tls.clone(), server.clone()).await;
            let result = client.call(call(true)).await;
            assert_eq!(result.is_ok(), total == "0");
            task.await.unwrap();
        }
    }
    #[tokio::test]
    async fn tls_identity_is_verified_and_admission_covers_cancelled_io() {
        let (tls, server) = tls_fixture();
        let (mut client, task) = fixture(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"
                .to_vec(),
            tls,
            server,
        )
        .await;
        client.origin = Url::parse(&format!(
            "https://wrong.example.com:{}",
            client.pinned.unwrap().port()
        ))
        .unwrap();
        assert!(client.call(call(false)).await.is_err());
        task.await.unwrap();
        let a = client
            .transport
            .slots
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        let b = client
            .transport
            .slots
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        assert!(matches!(client.call(call(false)).await, Err(Error::Busy)));
        drop((a, b));
        let (tls, server) = tls_fixture();
        let (client, task) = fixture(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 9999\r\n\r\n"
                .to_vec(),
            tls,
            server,
        )
        .await;
        assert!(client.call(call(false)).await.is_err());
        task.await.unwrap();
        for _ in 0..10 {
            if client.transport.slots.available_permits() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(client.transport.slots.available_permits(), 2);
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (tls, server) = tls_fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (ready_send, ready_receive) = tokio::sync::oneshot::channel();
        let held = Arc::new(tokio::sync::Notify::new());
        let server_held = held.clone();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = tokio_rustls::TlsAcceptor::from(server)
                .accept(stream)
                .await
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0u8; 1];
            while !headers.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).await.unwrap();
                headers.push(byte[0]);
                assert!(headers.len() < 16_384);
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 9999\r\n\r\n").await.unwrap();
            stream.flush().await.unwrap();
            ready_send.send(()).unwrap();
            server_held.notified().await;
            drop(stream);
        });
        let slots = Arc::new(Semaphore::new(2));
        let client = Client {
            transport: Transport {
                tls,
                slots: slots.clone(),
            },
            origin: Url::parse(&format!("https://localhost:{}", address.port())).unwrap(),
            pinned: Some(address),
        };
        let request = tokio::spawn(async move { client.call(call(false)).await });
        timeout(Duration::from_secs(3), ready_receive)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(slots.available_permits(), 1);
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        timeout(Duration::from_secs(1), async {
            while slots.available_permits() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        held.notify_one();
        task.await.unwrap();
    }
}
