//! Private AES-GCM boundary compatible with retained Go envelopes. Encryption
//! producers must reserve durable capacity before calling seal; this primitive
//! deliberately has no API serialization or connection authorization behavior.
use crate::{
    error::{Error, Result},
    validation,
};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path},
    sync::Arc,
};
use zeroize::{Zeroize, Zeroizing};

const MAX_PLAINTEXT: usize = 16_384;
pub const MAX_RESERVATIONS: i64 = 16_777_216;
const MAX_KEYRING: usize = 8192;

#[derive(Clone)]
pub struct Keyring(Arc<Ring>);
struct Ring {
    active: String,
    keys: BTreeMap<String, Material>,
}
struct Material {
    cipher: Aes256Gcm,
    fingerprint: [u8; 32],
}
pub struct Envelope(Vec<u8>);
pub struct Binding<'a> {
    pub client: &'a str,
    pub connection: &'a str,
    pub provider: &'a str,
    pub purpose: &'a str,
}
impl fmt::Debug for Keyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted integration key ring]")
    }
}
impl fmt::Debug for Envelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted integration envelope]")
    }
}

pub fn label(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 64
        && (raw.as_bytes()[0].is_ascii_lowercase() || raw.as_bytes()[0].is_ascii_digit())
        && raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}
pub fn purpose(provider: &str) -> Result<&'static str> {
    match provider {
        "meta_ads" => Ok("access_token"),
        "ga4" | "woocommerce" => Ok("provider_credential"),
        _ => Err(Error::Internal),
    }
}
impl Binding<'_> {
    fn valid(&self) -> bool {
        validation::id(self.client).is_ok()
            && validation::id(self.connection).is_ok()
            && purpose(self.provider).is_ok_and(|p| p == self.purpose)
    }
    fn associated(&self, header: &[u8]) -> Vec<u8> {
        let mut data = b"roisey-else/integration-credential\0".to_vec();
        data.extend_from_slice(header);
        for value in [self.client, self.connection, self.provider, self.purpose] {
            data.push(0);
            data.extend_from_slice(value.as_bytes());
        }
        data
    }
}
impl Envelope {
    pub fn parse(raw: Vec<u8>) -> Result<Self> {
        let envelope = Self(raw);
        envelope.parts()?;
        Ok(envelope)
    }
    fn parts(&self) -> Result<(&[u8], &[u8])> {
        let raw = &self.0;
        if raw.len() < 2 || raw.len() > 16_478 || raw[0] != 1 {
            return Err(Error::Internal);
        }
        let n = usize::from(raw[1]);
        if !(1..=64).contains(&n)
            || raw.len() < 2 + n + 29
            || raw.len() > 2 + n + 28 + MAX_PLAINTEXT
            || std::str::from_utf8(&raw[2..2 + n]).map_or(true, |s| !label(s))
        {
            return Err(Error::Internal);
        }
        Ok((&raw[..2 + n], &raw[2 + n..]))
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.0
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    active_key_id: String,
    keys: Vec<KeyDocument>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct KeyDocument {
    id: String,
    key_base64: String,
}
impl Drop for KeyDocument {
    fn drop(&mut self) {
        self.key_base64.zeroize();
    }
}

impl Keyring {
    /// Keep every retained decryption key. Restores always add random fresh
    /// material rather than restarting a potentially rewound nonce budget.
    pub(crate) fn fresh_restore_document(
        raw: &[u8],
        connection: &Connection,
    ) -> Result<Zeroizing<Vec<u8>>> {
        Self::parse(raw)?.preflight(connection, false, false)?;
        let mut document: Document = serde_json::from_slice(raw).map_err(|_| Error::Internal)?;
        if document.keys.len() >= 8 {
            return Err(Error::Conflict("integration_key_limit_reached"));
        }
        let label = format!("restore-{}", validation::new_id());
        let mut material = Zeroizing::new([0u8; 32]);
        rand::rng().fill_bytes(material.as_mut());
        document.active_key_id = label.clone();
        document.keys.push(KeyDocument {
            id: label,
            key_base64: STANDARD.encode(material.as_slice()),
        });
        let encoded = Zeroizing::new(serde_json::to_vec(&document).map_err(|_| Error::Internal)?);
        Self::parse(&encoded)?.preflight(connection, true, true)?;
        Ok(encoded)
    }
    pub fn parse(raw: &[u8]) -> Result<Self> {
        if raw.is_empty() || raw.len() > MAX_KEYRING {
            return Err(Error::Internal);
        }
        // Derive rejects repeated, aliased and unknown fields at each level.
        let document: Document = serde_json::from_slice(raw).map_err(|_| Error::Internal)?;
        if !label(&document.active_key_id) || document.keys.is_empty() || document.keys.len() > 8 {
            return Err(Error::Internal);
        }
        let mut keys = BTreeMap::new();
        let mut materials = BTreeSet::new();
        for entry in &document.keys {
            if !label(&entry.id) || keys.contains_key(&entry.id) {
                return Err(Error::Internal);
            }
            let key = Zeroizing::new(
                STANDARD
                    .decode(&entry.key_base64)
                    .map_err(|_| Error::Internal)?,
            );
            if key.len() != 32
                || key.iter().all(|b| *b == 0)
                || STANDARD.encode(key.as_slice()) != entry.key_base64
            {
                return Err(Error::Internal);
            }
            let fingerprint: [u8; 32] = Sha256::digest(&*key).into();
            if !materials.insert(fingerprint) {
                return Err(Error::Internal);
            }
            let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| Error::Internal)?;
            keys.insert(
                entry.id.clone(),
                Material {
                    cipher,
                    fingerprint,
                },
            );
        }
        if !keys.contains_key(&document.active_key_id) {
            return Err(Error::Internal);
        }
        Ok(Self(Arc::new(Ring {
            active: document.active_key_id,
            keys,
        })))
    }
    pub fn load(path: &Path) -> Result<Self> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
        {
            return Err(Error::Internal);
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| Error::Internal)?;
        let before = file.metadata().map_err(|_| Error::Internal)?;
        // The descriptor avoids symlink races and FIFO waits. Parent directories
        // remain a trusted deployment mount boundary, as in the prior loader.
        let uid = unsafe { libc::geteuid() };
        if !before.is_file()
            || before.nlink() != 1
            || !matches!(before.mode() & 0o7777, 0o400 | 0o600)
            || (before.uid() != uid && before.uid() != 0)
            || before.len() == 0
            || before.len() > MAX_KEYRING as u64
        {
            return Err(Error::Internal);
        }
        let mut raw = Zeroizing::new(Vec::new());
        Read::by_ref(&mut file)
            .take((MAX_KEYRING + 1) as u64)
            .read_to_end(&mut raw)
            .map_err(|_| Error::Internal)?;
        let ring = Self::parse(&raw)?;
        let after = file.metadata().map_err(|_| Error::Internal)?;
        if (
            before.dev(),
            before.ino(),
            before.len(),
            before.mode(),
            before.uid(),
            before.nlink(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (
            after.dev(),
            after.ino(),
            after.len(),
            after.mode(),
            after.uid(),
            after.nlink(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        ) {
            return Err(Error::Internal);
        }
        Ok(ring)
    }
    pub(crate) fn active(&self) -> (&str, [u8; 32]) {
        (&self.0.active, self.0.keys[&self.0.active].fingerprint)
    }
    pub(crate) fn identities(&self) -> Vec<(&str, [u8; 32])> {
        self.0
            .keys
            .iter()
            .map(|(label, material)| (label.as_str(), material.fingerprint))
            .collect()
    }
    /// Startup observation changes no key identity, quota, credential or audit.
    /// Declared restores require externally fresh active material and retained
    /// decryption keys; undeclared counter rewinds cannot be inferred here.
    pub fn preflight(&self, connection: &Connection, restored: bool, writing: bool) -> Result<()> {
        for (label, material) in &self.0.keys {
            let saved:Option<(String,Vec<u8>,i64)>=connection.query_row("SELECT key_label,fingerprint,reservations FROM integration_encryption_keys WHERE key_label=?1 OR fingerprint=?2",params![label,material.fingerprint.as_slice()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((saved_label, digest, used)) = saved
                && (saved_label != *label
                    || digest != material.fingerprint
                    || (label == &self.0.active
                        && (restored || (writing && used >= MAX_RESERVATIONS))))
            {
                return Err(Error::Internal);
            }
        }
        let mut statement=connection.prepare("SELECT DISTINCT k.key_label,k.fingerprint FROM integration_credentials c JOIN integration_encryption_keys k ON k.id=c.key_id")?;
        let identities = statement.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })?;
        for identity in identities {
            let (label, fingerprint) = identity?;
            if self
                .0
                .keys
                .get(&label)
                .is_none_or(|m| m.fingerprint.as_slice() != fingerprint)
            {
                return Err(Error::Internal);
            }
        }
        Ok(())
    }
    pub(crate) fn seal(&self, binding: &Binding<'_>, plaintext: &[u8]) -> Result<Envelope> {
        if !binding.valid() || plaintext.is_empty() || plaintext.len() > MAX_PLAINTEXT {
            return Err(Error::Internal);
        }
        let mut data = vec![1, self.0.active.len() as u8];
        data.extend_from_slice(self.0.active.as_bytes());
        let associated = binding.associated(&data);
        let mut nonce = [0u8; 12];
        rand::rng().fill_bytes(&mut nonce);
        let encrypted = self.0.keys[&self.0.active]
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &associated,
                },
            )
            .map_err(|_| Error::Internal)?;
        data.extend_from_slice(&nonce);
        data.extend_from_slice(&encrypted);
        Ok(Envelope(data))
    }
    pub(crate) fn open(
        &self,
        binding: &Binding<'_>,
        envelope: &Envelope,
    ) -> Result<Zeroizing<Vec<u8>>> {
        if !binding.valid() {
            return Err(Error::Internal);
        }
        let (header, encrypted) = envelope.parts()?;
        let label = std::str::from_utf8(&header[2..]).map_err(|_| Error::Internal)?;
        let material = self.0.keys.get(label).ok_or(Error::Internal)?;
        let data = material
            .cipher
            .decrypt(
                Nonce::from_slice(&encrypted[..12]),
                Payload {
                    msg: &encrypted[12..],
                    aad: &binding.associated(header),
                },
            )
            .map_err(|_| Error::Internal)?;
        Ok(Zeroizing::new(data))
    }
}

/// Fresh installation only. Never replace a missing key source when ciphertext
/// already exists; the retained key must be restored by the operator.
pub fn provision(path: &Path, connection: &Connection) -> Result<()> {
    if path.symlink_metadata().is_ok() {
        return Ok(());
    }
    let stored: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM integration_credentials)",
        [],
        |r| r.get(0),
    )?;
    if stored {
        return Err(Error::Internal);
    }
    let parent = path.parent().ok_or(Error::Internal)?;
    match fs::DirBuilder::new().mode(0o700).create(parent) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err(Error::Internal),
    }
    let directory = parent.symlink_metadata().map_err(|_| Error::Internal)?;
    if !directory.is_dir() || directory.file_type().is_symlink() || directory.mode() & 0o077 != 0 {
        return Err(Error::Internal);
    }
    let mut key = Zeroizing::new([0u8; 32]);
    rand::rng().fill_bytes(key.as_mut());
    let encoded = Zeroizing::new(STANDARD.encode(key.as_slice()));
    let document = Zeroizing::new(format!(
        r#"{{"active_key_id":"initial-v1","keys":[{{"id":"initial-v1","key_base64":"{}"}}]}}"#,
        *encoded
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| Error::Internal)?;
    file.write_all(document.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| Error::Internal)?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| Error::Internal)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    pub(crate) fn synthetic(label: &str, value: u8) -> Keyring {
        let data = serde_json::json!({"active_key_id":label,"keys":[{"id":label,"key_base64":STANDARD.encode([value;32])}]});
        Keyring::parse(&serde_json::to_vec(&data).unwrap()).unwrap()
    }
    fn binding() -> Binding<'static> {
        Binding {
            client: "00000000-0000-4000-8000-000000000001",
            connection: "00000000-0000-4000-8000-000000000002",
            provider: "meta_ads",
            purpose: "access_token",
        }
    }
    #[test]
    fn retained_go_envelope_is_authenticated_and_every_byte_is_bound() {
        let ring = synthetic("synthetic-one", 0x6b);
        // Deterministic synthetic fixture from standard-library Go AES-GCM,
        // using the exact retained header/AAD and an explicit test-only nonce.
        let hex = "010d73796e7468657469632d6f6e65111111111111111111111111690c5d03fbf78b772b68cb83e7bab335d52b7105b5843868fd9136e00883f3d9c899b781";
        let raw: Vec<_> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let envelope = Envelope::parse(raw.clone()).unwrap();
        assert_eq!(
            ring.open(&binding(), &envelope).unwrap().as_slice(),
            b"synthetic-credential"
        );
        for index in 0..raw.len() {
            let mut changed = raw.clone();
            changed[index] ^= 1;
            assert!(
                Envelope::parse(changed)
                    .and_then(|e| ring.open(&binding(), &e))
                    .is_err(),
                "byte {index}"
            );
        }
        for field in 0..4 {
            let mut wrong = binding();
            match field {
                0 => wrong.client = "00000000-0000-4000-8000-000000000003",
                1 => wrong.connection = "00000000-0000-4000-8000-000000000004",
                2 => wrong.provider = "ga4",
                _ => wrong.purpose = "provider_credential",
            };
            assert!(ring.open(&wrong, &envelope).is_err());
        }
        let mut nonces = BTreeSet::new();
        for _ in 0..100 {
            let e = ring.seal(&binding(), b"synthetic-credential").unwrap();
            let (_, encrypted) = e.parts().unwrap();
            assert!(nonces.insert(encrypted[..12].to_vec()));
        }
        assert_eq!(format!("{ring:?}"), "[redacted integration key ring]");
        assert_eq!(format!("{envelope:?}"), "[redacted integration envelope]");
    }
    #[test]
    fn strict_key_documents_and_protected_files_refuse_ambiguous_sources() {
        let ring = serde_json::json!({"active_key_id":"synthetic-one","keys":[{"id":"synthetic-one","key_base64":STANDARD.encode([0x6b;32])}]});
        let raw = serde_json::to_vec(&ring).unwrap();
        let duplicate = String::from_utf8(raw.clone()).unwrap().replace(
            "\"active_key_id\":",
            "\"active_key_id\":\"synthetic-one\",\"active_key_id\":",
        );
        assert!(Keyring::parse(duplicate.as_bytes()).is_err());
        let mut zero = ring.clone();
        zero["keys"][0]["key_base64"] = Value::String(STANDARD.encode([0; 32]));
        assert!(Keyring::parse(&serde_json::to_vec(&zero).unwrap()).is_err());
        let mut alias = ring.clone();
        alias["keys"].as_array_mut().unwrap().push(
            serde_json::json!({"id":"synthetic-alias","key_base64":STANDARD.encode([0x6b;32])}),
        );
        assert!(Keyring::parse(&serde_json::to_vec(&alias).unwrap()).is_err());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("keyring.json");
        fs::write(&path, &raw).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        Keyring::load(&path).unwrap();
        let linked = directory.path().join("linked.json");
        symlink(&path, &linked).unwrap();
        assert!(Keyring::load(&linked).is_err());
        fs::hard_link(&path, directory.path().join("hard.json")).unwrap();
        assert!(Keyring::load(&path).is_err());
        fs::remove_file(directory.path().join("hard.json")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(Keyring::load(&path).is_err());
    }
    #[test]
    fn provisioning_never_replaces_a_key_and_declared_restores_require_fresh_material() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".control/keyring.json");
        let db = crate::db::Database::open(&directory.path().join("else.sqlite3"), true).unwrap();
        drop(db);
        let conn = crate::db::connection(&directory.path().join("else.sqlite3")).unwrap();
        provision(&path, &conn).unwrap();
        let original = fs::read(&path).unwrap();
        provision(&path, &conn).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        let ring = Keyring::load(&path).unwrap();
        ring.preflight(&conn, false, true).unwrap();
        let (label, digest) = ring.active();
        conn.execute(
            "INSERT INTO integration_encryption_keys VALUES (?1,?2,?3,1,?4)",
            params![
                validation::new_id(),
                label,
                digest.as_slice(),
                validation::now()
            ],
        )
        .unwrap();
        ring.preflight(&conn, false, true).unwrap();
        assert!(ring.preflight(&conn, true, true).is_err());
        let fresh = synthetic("synthetic-fresh", 0x42);
        fresh.preflight(&conn, true, true).unwrap();
        assert!(
            conn.execute("UPDATE integration_encryption_keys SET reservations=0", [])
                .is_err()
        );
        assert!(
            conn.execute("DELETE FROM integration_encryption_keys", [])
                .is_err()
        );
    }
    use serde_json::Value;
}
