//! Private credentials only: no serde serialization, endpoint discovery or logs.
//! RSA parsing/signing runs in separately admitted blocking work, including when
//! the caller is cancelled. Google keys retain the old PKCS#8/RS256 contract.
use crate::{
    error::{Error, Result},
    provider_json,
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, Datelike, Duration, Utc};
use ring::{
    rand::SystemRandom,
    signature::{self, RsaKeyPair},
};
use serde_json::{Value, json};
use std::{fmt, sync::Arc};
use tokio::sync::Semaphore;
use zeroize::{Zeroize, Zeroizing};

pub const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/analytics.readonly";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

#[derive(Clone)]
pub struct Crypto {
    slots: Arc<Semaphore>,
}
impl Default for Crypto {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(2)),
        }
    }
}
impl Crypto {
    pub async fn parse(&self, provider: String, raw: Zeroizing<Vec<u8>>) -> Result<Credential> {
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            match provider.as_str() {
                "ga4" => Ok(Credential::Ga4(Arc::new(ServiceAccount::parse(&raw)?))),
                "woocommerce" => Ok(Credential::Commerce(ReadKey::parse(&raw)?)),
                "meta_ads" => Ok(Credential::Meta(ReadToken::parse(&raw)?)),
                _ => Err(Error::Internal),
            }
        })
        .await
        .map_err(|_| Error::Internal)?
    }
    pub async fn assertion(
        &self,
        account: Arc<ServiceAccount>,
        now: DateTime<Utc>,
    ) -> Result<Zeroizing<String>> {
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            account.assertion(now)
        })
        .await
        .map_err(|_| Error::Internal)?
    }
}
pub enum Credential {
    Ga4(Arc<ServiceAccount>),
    Commerce(ReadKey),
    Meta(ReadToken),
}
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[private provider credential]")
    }
}

struct SecretJson(Value);
impl Drop for SecretJson {
    fn drop(&mut self) {
        clear_json(&mut self.0)
    }
}
fn clear_json(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(clear_json),
        Value::Object(values) => values.values_mut().for_each(clear_json),
        _ => {}
    }
}

pub struct ServiceAccount {
    email: String,
    key_id: String,
    key: RsaKeyPair,
}
impl fmt::Debug for ServiceAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[private GA4 service account]")
    }
}
impl ServiceAccount {
    fn parse(raw: &[u8]) -> Result<Self> {
        if raw.is_empty() || raw.len() > 16_384 {
            return Err(Error::Internal);
        }
        let value = SecretJson(provider_json::parse(raw)?);
        let object = provider_json::object(
            &value.0,
            &[
                "type",
                "project_id",
                "private_key_id",
                "private_key",
                "client_email",
                "client_id",
                "auth_uri",
                "token_uri",
                "auth_provider_x509_cert_url",
                "client_x509_cert_url",
                "universe_domain",
            ],
        )?;
        if object
            .values()
            .any(|v| v.as_str().is_none_or(|s| s.len() > 12_288))
            || provider_json::text(object, "type")? != "service_account"
            || provider_json::text(object, "token_uri")? != TOKEN_ENDPOINT
            || object
                .get("universe_domain")
                .is_some_and(|v| v.as_str() != Some("googleapis.com"))
        {
            return Err(Error::Internal);
        }
        let email = provider_json::text(object, "client_email")?;
        let key_id = provider_json::text(object, "private_key_id")?;
        if !service_email(email)
            || key_id.is_empty()
            || key_id.len() > 128
            || !key_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(Error::Internal);
        }
        let der = private_der(provider_json::text(object, "private_key")?)?;
        bounded_rsa(&der)?;
        let key = RsaKeyPair::from_pkcs8(&der).map_err(|_| Error::Internal)?;
        Ok(Self {
            email: email.into(),
            key_id: key_id.into(),
            key,
        })
    }
    fn assertion(&self, now: DateTime<Utc>) -> Result<Zeroizing<String>> {
        if !(2000..=9998).contains(&now.year()) {
            return Err(Error::Internal);
        }
        let header = serde_json::to_vec(&json!({"alg":"RS256","typ":"JWT","kid":self.key_id}))
            .map_err(|_| Error::Internal)?;
        let claims=Zeroizing::new(serde_json::to_vec(&json!({"iss":self.email,"scope":GOOGLE_SCOPE,"aud":TOKEN_ENDPOINT,"iat":now.timestamp(),"exp":now.timestamp()+3600})).map_err(|_|Error::Internal)?);
        let unsigned = Zeroizing::new(format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(&*claims)
        ));
        let mut signature = Zeroizing::new(vec![0u8; self.key.public().modulus_len()]);
        self.key
            .sign(
                &signature::RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                unsigned.as_bytes(),
                &mut signature,
            )
            .map_err(|_| Error::Internal)?;
        Ok(Zeroizing::new(format!(
            "{}.{}",
            *unsigned,
            URL_SAFE_NO_PAD.encode(&*signature)
        )))
    }
    pub(crate) async fn token_form(
        self: Arc<Self>,
        crypto: &Crypto,
        now: DateTime<Utc>,
    ) -> Result<Zeroizing<String>> {
        let assertion = crypto.assertion(self, now).await?;
        let form = Zeroizing::new(
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
                .append_pair("assertion", &assertion)
                .finish(),
        );
        Ok(form)
    }
}
fn service_email(email: &str) -> bool {
    let Some((name, domain)) = email.split_once('@') else {
        return false;
    };
    let Some(project) = domain.strip_suffix(".iam.gserviceaccount.com") else {
        return false;
    };
    let start = |s: &str| {
        s.as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    };
    !name.is_empty()
        && name.len() <= 128
        && start(name)
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
        && !project.is_empty()
        && project.len() <= 63
        && start(project)
        && project
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn private_der(pem: &str) -> Result<Zeroizing<Vec<u8>>> {
    let body = pem
        .trim()
        .strip_prefix("-----BEGIN PRIVATE KEY-----")
        .and_then(|s| s.strip_suffix("-----END PRIVATE KEY-----"))
        .ok_or(Error::Internal)?;
    let mut encoded = Zeroizing::new(String::with_capacity(body.len()));
    for byte in body.bytes() {
        if matches!(byte, b'\r' | b'\n') {
            continue;
        }
        if !byte.is_ascii_alphanumeric() && !b"+/=".contains(&byte) {
            return Err(Error::Internal);
        }
        encoded.push(char::from(byte));
    }
    let der = Zeroizing::new(
        STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| Error::Internal)?,
    );
    if der.is_empty() || der.len() > 8192 || STANDARD.encode(&*der) != *encoded {
        return Err(Error::Internal);
    }
    Ok(der)
}

// Small strict DER reader: bounds every integer before cryptographic parsing.
// It does not validate RSA mathematics; ring performs that validation afterward.
fn take_der<'a>(input: &mut &'a [u8], tag: u8) -> Result<&'a [u8]> {
    if input.len() < 2 || input[0] != tag {
        return Err(Error::Internal);
    }
    let first = input[1];
    let (length, header) = if first < 128 {
        (usize::from(first), 2)
    } else {
        let bytes = usize::from(first & 127);
        if bytes == 0 || bytes > 2 || input.len() < 2 + bytes || input[2] == 0 {
            return Err(Error::Internal);
        }
        let length = input[2..2 + bytes]
            .iter()
            .fold(0usize, |n, b| n * 256 + usize::from(*b));
        if length < 128 {
            return Err(Error::Internal);
        }
        (length, 2 + bytes)
    };
    if length > 8192 || input.len() < header + length {
        return Err(Error::Internal);
    }
    let value = &input[header..header + length];
    *input = &input[header + length..];
    Ok(value)
}
fn positive_integer<'a>(input: &mut &'a [u8]) -> Result<&'a [u8]> {
    let value = take_der(input, 2)?;
    if value.is_empty()
        || value[0] & 128 != 0
        || value == [0]
        || (value.len() > 1 && value[0] == 0 && value[1] & 128 == 0)
    {
        return Err(Error::Internal);
    }
    let value = value.strip_prefix(&[0]).unwrap_or(value);
    if value.len() > 512 {
        return Err(Error::Internal);
    }
    Ok(value)
}
fn bounded_rsa(der: &[u8]) -> Result<()> {
    let mut outer = der;
    let mut container = take_der(&mut outer, 0x30)?;
    if !outer.is_empty() || take_der(&mut container, 2)? != [0] {
        return Err(Error::Internal);
    }
    let algorithm = take_der(&mut container, 0x30)?;
    if algorithm != [6, 9, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 1, 5, 0] {
        return Err(Error::Internal);
    }
    let mut encoded = take_der(&mut container, 4)?;
    if !container.is_empty() {
        return Err(Error::Internal);
    }
    let mut rsa = take_der(&mut encoded, 0x30)?;
    if !encoded.is_empty() || take_der(&mut rsa, 2)? != [0] {
        return Err(Error::Internal);
    }
    let modulus = positive_integer(&mut rsa)?;
    let bits = modulus.len() * 8 - modulus[0].leading_zeros() as usize;
    if !(2048..=4096).contains(&bits) || positive_integer(&mut rsa)? != [1, 0, 1] {
        return Err(Error::Internal);
    }
    for _ in 0..6 {
        positive_integer(&mut rsa)?;
    }
    if !rsa.is_empty() {
        return Err(Error::Internal);
    }
    Ok(())
}

pub struct AccessToken {
    value: Zeroizing<String>,
    expires: DateTime<Utc>,
}
impl fmt::Debug for AccessToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[private GA4 access token]")
    }
}
impl AccessToken {
    pub(crate) fn parse(value: Value, now: DateTime<Utc>) -> Result<Self> {
        let value = SecretJson(value);
        let object = provider_json::object(
            &value.0,
            &["access_token", "token_type", "expires_in", "scope"],
        )?;
        let token = provider_json::text(object, "access_token")?;
        let seconds = object
            .get("expires_in")
            .and_then(Value::as_u64)
            .ok_or(Error::Internal)?;
        if provider_json::text(object, "token_type")? != "Bearer"
            || object
                .get("scope")
                .is_some_and(|v| v.as_str() != Some(GOOGLE_SCOPE))
            || token.is_empty()
            || token.len() > 2048
            || !token.bytes().all(|b| (33..=126).contains(&b))
            || !(60..=3600).contains(&seconds)
        {
            return Err(Error::Internal);
        }
        Ok(Self {
            value: Zeroizing::new(token.into()),
            expires: now + Duration::seconds(seconds as i64),
        })
    }
    pub fn authorization(&self, now: DateTime<Utc>) -> Result<Zeroizing<String>> {
        if now >= self.expires - Duration::seconds(30) {
            return Err(Error::Internal);
        }
        Ok(Zeroizing::new(format!("Bearer {}", *self.value)))
    }
}
pub struct ReadKey {
    key: Zeroizing<String>,
    secret: Zeroizing<String>,
}
impl fmt::Debug for ReadKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[private WooCommerce read key]")
    }
}
impl ReadKey {
    fn parse(raw: &[u8]) -> Result<Self> {
        if raw.is_empty() || raw.len() > 1024 {
            return Err(Error::Internal);
        }
        let value = SecretJson(provider_json::parse(raw)?);
        let object = provider_json::object(&value.0, &["consumer_key", "consumer_secret"])?;
        if object.len() != 2 {
            return Err(Error::Internal);
        }
        let key = provider_json::text(object, "consumer_key")?;
        let secret = provider_json::text(object, "consumer_secret")?;
        for (value, prefix) in [(key, "ck_"), (secret, "cs_")] {
            let suffix = value.strip_prefix(prefix).ok_or(Error::Internal)?;
            if suffix.len() != 40
                || !suffix
                    .bytes()
                    .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
                || suffix.bytes().all(|b| b == b'0')
            {
                return Err(Error::Internal);
            }
        }
        Ok(Self {
            key: Zeroizing::new(key.into()),
            secret: Zeroizing::new(secret.into()),
        })
    }
    pub fn authorization(&self) -> Zeroizing<String> {
        let pair = Zeroizing::new(format!("{}:{}", *self.key, *self.secret));
        Zeroizing::new(format!("Basic {}", STANDARD.encode(pair.as_bytes())))
    }
}
pub struct ReadToken {
    value: Zeroizing<String>,
}
impl fmt::Debug for ReadToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[private Meta read token]")
    }
}
impl ReadToken {
    fn parse(raw: &[u8]) -> Result<Self> {
        let value = std::str::from_utf8(raw).map_err(|_| Error::Internal)?;
        let body = value.trim_end_matches('=');
        if !(16..=4096).contains(&raw.len())
            || value.len() - body.len() > 2
            || body.is_empty()
            || !body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._~+/-".contains(&b))
        {
            return Err(Error::Internal);
        }
        Ok(Self {
            value: Zeroizing::new(value.into()),
        })
    }
    pub fn authorization(&self) -> Zeroizing<String> {
        Zeroizing::new(format!("Bearer {}", *self.value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;
    use std::process::Command;
    fn document(bits: usize, exponent: usize) -> Value {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("synthetic-only.pem");
        let status = Command::new("openssl")
            .args(["genpkey", "-algorithm", "RSA", "-pkeyopt"])
            .arg(format!("rsa_keygen_bits:{bits}"))
            .arg("-pkeyopt")
            .arg(format!("rsa_keygen_pubexp:{exponent}"))
            .arg("-out")
            .arg(&file)
            .output()
            .expect("OpenSSL is required for isolated key tests");
        assert!(status.status.success());
        json!({"type":"service_account","client_email":"synthetic@sample-project.iam.gserviceaccount.com","private_key_id":"synthetic-key-id","private_key":std::fs::read_to_string(file).unwrap(),"token_uri":TOKEN_ENDPOINT,"universe_domain":"googleapis.com"})
    }
    #[tokio::test]
    async fn ga4_signed_assertion_keeps_exact_read_scope_audience_and_key_bounds() {
        let value = document(2048, 65537);
        let raw = Zeroizing::new(serde_json::to_vec(&value).unwrap());
        let crypto = Crypto::default();
        let Credential::Ga4(account) = crypto.parse("ga4".into(), raw).await.unwrap() else {
            panic!("wrong credential");
        };
        let now = DateTime::parse_from_rfc3339("2026-10-06T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let assertion = crypto.assertion(account.clone(), now).await.unwrap();
        let parts: Vec<_> = assertion.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(
            header,
            json!({"alg":"RS256","typ":"JWT","kid":"synthetic-key-id"})
        );
        assert_eq!(
            claims,
            json!({"iss":value["client_email"],"scope":GOOGLE_SCOPE,"aud":TOKEN_ENDPOINT,"iat":now.timestamp(),"exp":now.timestamp()+3600})
        );
        signature::UnparsedPublicKey::new(
            &signature::RSA_PKCS1_2048_8192_SHA256,
            account.key.public_key().as_ref(),
        )
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &URL_SAFE_NO_PAD.decode(parts[2]).unwrap(),
        )
        .unwrap();
        assert!(!assertion.contains("PRIVATE KEY"));
        assert_eq!(format!("{account:?}"), "[private GA4 service account]");
        for (field, bad) in [
            ("token_uri", "https://private.example/token"),
            ("universe_domain", "private.example"),
            ("type", "authorized_user"),
            ("client_email", "private@example.com"),
            ("private_key_id", "unsafe\r\nheader"),
            ("subject", "impersonated@example.com"),
            ("private_key", "malformed PEM"),
        ] {
            let mut candidate = value.clone();
            candidate[field] = Value::String(bad.into());
            assert!(
                ServiceAccount::parse(&serde_json::to_vec(&candidate).unwrap()).is_err(),
                "{field}"
            );
        }
        for value in [document(1024, 65537), document(2048, 3)] {
            assert!(ServiceAccount::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        assert!(
            ServiceAccount::parse(br#"{"type":"service_account","type":"service_account"}"#)
                .is_err()
        );
        let a = crypto.slots.clone().acquire_owned().await.unwrap();
        let b = crypto.slots.clone().acquire_owned().await.unwrap();
        assert!(matches!(
            crypto.parse("ga4".into(), Zeroizing::new(vec![])).await,
            Err(Error::Busy)
        ));
        drop((a, b));
    }
    #[test]
    fn token_responses_reject_privilege_expansion_and_near_expiry() {
        let now = Utc::now();
        let token=AccessToken::parse(json!({"access_token":"synthetic.private-token","token_type":"Bearer","expires_in":3600,"scope":GOOGLE_SCOPE}),now).unwrap();
        assert_eq!(
            &*token.authorization(now).unwrap(),
            "Bearer synthetic.private-token"
        );
        assert!(token.authorization(now + Duration::seconds(3570)).is_err());
        assert_eq!(format!("{token:?}"), "[private GA4 access token]");
        for candidate in [
            json!({"error":"private-diagnostic"}),
            json!({"access_token":"private","token_type":"Bearer","expires_in":3600,"scope":"https://www.googleapis.com/auth/analytics.edit"}),
            json!({"access_token":"private","token_type":"bearer","expires_in":3600}),
            json!({"access_token":"private","token_type":"Bearer","expires_in":"3600"}),
            json!({"access_token":"private","token_type":"Bearer","expires_in":59}),
            json!({"access_token":"private","token_type":"Bearer","expires_in":3601}),
            json!({"access_token":"private\r\nheader","token_type":"Bearer","expires_in":3600}),
            json!({"access_token":"private","token_type":"Bearer","expires_in":3600,"id_token":"private"}),
        ] {
            assert!(AccessToken::parse(candidate, now).is_err());
        }
    }
    #[test]
    fn commerce_and_meta_credentials_reject_expansion_and_keep_headers_private() {
        let key = format!("ck_{}", "1".repeat(40));
        let secret = format!("cs_{}", "2".repeat(40));
        let value = json!({"consumer_key":key,"consumer_secret":secret});
        let credential = ReadKey::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        let header = credential.authorization();
        assert_eq!(
            STANDARD
                .decode(header.strip_prefix("Basic ").unwrap())
                .unwrap(),
            format!("{key}:{secret}").as_bytes()
        );
        assert_eq!(format!("{credential:?}"), "[private WooCommerce read key]");
        let mut expanded = value.clone();
        expanded["origin"] = json!("https://private.example");
        assert!(ReadKey::parse(&serde_json::to_vec(&expanded).unwrap()).is_err());
        let zero = json!({"consumer_key":format!("ck_{}","0".repeat(40)),"consumer_secret":secret});
        assert!(ReadKey::parse(&serde_json::to_vec(&zero).unwrap()).is_err());
        assert!(ReadKey::parse(br#"{"consumer_key":"x","consumer_key":"x"}"#).is_err());
        let token = ReadToken::parse(b"synthetic.meta-token==").unwrap();
        assert_eq!(&*token.authorization(), "Bearer synthetic.meta-token==");
        assert_eq!(format!("{token:?}"), "[private Meta read token]");
        for bad in [
            "short",
            "synthetic token unsafe",
            "synthetic=token",
            "synthetic-token===",
            "synthetic-token\r\nheader",
        ] {
            assert!(ReadToken::parse(bad.as_bytes()).is_err());
        }
    }
}
