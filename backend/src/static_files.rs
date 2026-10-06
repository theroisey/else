use crate::error::{Error, Result};
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Read, path::Path};

pub struct Asset {
    pub body: Bytes,
    pub content_type: &'static str,
    pub etag: String,
    pub immutable: bool,
    pub gzip: Option<Bytes>,
}
pub struct Assets {
    files: HashMap<String, Asset>,
}

impl Assets {
    /// Snapshot the read-only production artifact at startup; requests never open paths.
    pub fn load(root: &Path) -> Result<Self> {
        let mut files = HashMap::new();
        let mut total = 0usize;
        let mut pending = vec![root.to_owned()];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(&directory).map_err(|_| Error::Internal)? {
                let entry = entry.map_err(|_| Error::Internal)?;
                let path = entry.path();
                let metadata = std::fs::symlink_metadata(&path).map_err(|_| Error::Internal)?;
                if metadata.file_type().is_symlink() {
                    return Err(Error::Internal);
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| Error::Internal)?
                    .to_str()
                    .ok_or(Error::Internal)?
                    .to_owned();
                if metadata.is_dir() {
                    if relative != "assets" {
                        return Err(Error::Internal);
                    }
                    pending.push(path);
                    continue;
                }
                if !metadata.is_file()
                    || metadata.len() == 0
                    || metadata.len() > 10 * 1024 * 1024
                    || files.len() >= 1000
                {
                    return Err(Error::Internal);
                }
                if relative.ends_with(".gz") {
                    continue;
                }
                let content_type = match relative.as_str() {
                    "index.html" => "text/html; charset=utf-8",
                    "assets/roisey-r-v1.svg" => "image/svg+xml",
                    value if value.starts_with("assets/") => {
                        match path.extension().and_then(|v| v.to_str()) {
                            Some("js") => "text/javascript; charset=utf-8",
                            Some("css") => "text/css; charset=utf-8",
                            Some("woff2") => "font/woff2",
                            Some("woff") => "font/woff",
                            Some("ttf") => "font/ttf",
                            _ => return Err(Error::Internal),
                        }
                    }
                    _ => return Err(Error::Internal),
                };
                let body = std::fs::read(&path).map_err(|_| Error::Internal)?;
                total = total.checked_add(body.len()).ok_or(Error::Internal)?;
                if total > 64 * 1024 * 1024 || body.len() as u64 != metadata.len() {
                    return Err(Error::Internal);
                }
                if relative == "index.html" && body.len() > 64 * 1024 {
                    return Err(Error::Internal);
                }
                let gzip_path = path.with_file_name(format!(
                    "{}.gz",
                    path.file_name()
                        .and_then(|v| v.to_str())
                        .ok_or(Error::Internal)?
                ));
                let gzip = if gzip_path.exists() {
                    let metadata =
                        std::fs::symlink_metadata(&gzip_path).map_err(|_| Error::Internal)?;
                    if !metadata.is_file()
                        || metadata.file_type().is_symlink()
                        || metadata.len() > 10 * 1024 * 1024
                    {
                        return Err(Error::Internal);
                    }
                    let content = std::fs::read(gzip_path).map_err(|_| Error::Internal)?;
                    total += content.len();
                    if total > 64 * 1024 * 1024 || content.len() as u64 != metadata.len() {
                        return Err(Error::Internal);
                    }
                    // Verify the built alternate representation before accepting requests.
                    // A bounded decode rejects corrupt CRCs and expansion beyond the asset.
                    let mut decoded = Vec::new();
                    let decoder = flate2::read::MultiGzDecoder::new(content.as_slice());
                    decoder
                        .take(body.len() as u64 + 1)
                        .read_to_end(&mut decoded)
                        .map_err(|_| Error::Internal)?;
                    if decoded != body {
                        return Err(Error::Internal);
                    }
                    Some(Bytes::from(content))
                } else {
                    None
                };
                let immutable = hashed_name(&relative);
                let etag = format!("\"{:x}\"", Sha256::digest(&body));
                files.insert(
                    format!("/{relative}"),
                    Asset {
                        body: Bytes::from(body),
                        content_type,
                        etag,
                        immutable,
                        gzip,
                    },
                );
            }
        }
        if !files.contains_key("/index.html") || files.len() < 2 {
            return Err(Error::Internal);
        }
        Ok(Self { files })
    }

    pub fn get(&self, path: &str) -> Result<&Asset> {
        if !path.starts_with('/')
            || path.contains(['%', '\\', '\0'])
            || path.contains("//")
            || path.split('/').any(|part| matches!(part, "." | ".."))
        {
            return Err(Error::NotFound);
        }
        if let Some(asset) = self.files.get(path) {
            return Ok(asset);
        }
        if matches!(
            path,
            "/" | "/login" | "/interface" | "/service-status" | "/app"
        ) || path.starts_with("/app/")
        {
            return self.files.get("/index.html").ok_or(Error::Internal);
        }
        Err(Error::NotFound)
    }
}

fn hashed_name(path: &str) -> bool {
    let Some((stem, extension)) = path.rsplit_once('.') else {
        return false;
    };
    matches!(extension, "js" | "css" | "woff" | "woff2" | "ttf")
        && stem.len() > 9
        && stem.as_bytes()[stem.len() - 9] == b'-'
        && stem.as_bytes()[stem.len() - 8..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(c))
}

pub fn accepts_gzip(value: &str) -> bool {
    value.split(',').any(|part| {
        let mut fields = part.trim().split(';');
        if fields
            .next()
            .is_none_or(|name| !name.trim().eq_ignore_ascii_case("gzip"))
        {
            return false;
        }
        let mut quality = 1.0f32;
        for parameter in fields {
            if let Some(q) = parameter.trim().strip_prefix("q=") {
                quality = q.parse().unwrap_or(0.0);
            }
        }
        quality > 0.0 && quality <= 1.0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_artifact_routes_and_traversal_are_bounded() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("assets")).unwrap();
        std::fs::write(
            root.path().join("index.html"),
            "<!doctype html><title>Synthetic frontend</title>",
        )
        .unwrap();
        std::fs::write(
            root.path().join("assets/index-1234AbCd.js"),
            "console.log('synthetic')",
        )
        .unwrap();
        let assets = Assets::load(root.path()).unwrap();
        assert!(assets.get("/app/clients/synthetic").is_ok());
        assert!(assets.get("/assets/index-1234AbCd.js").unwrap().immutable);
        for path in [
            "/api/v1/unknown",
            "/assets/missing.js",
            "/../index.html",
            "/%2e%2e/index.html",
            "//index.html",
            "/app/../index.html",
            "/app\\index.html",
        ] {
            assert!(assets.get(path).is_err(), "{path}");
        }
        assert!(!accepts_gzip("gzip;q=0, br"));
        assert!(accepts_gzip("br, gzip;q=0.8"));
        let mut compressed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        std::io::Write::write_all(&mut compressed, b"console.log('synthetic')").unwrap();
        let good = compressed.finish().unwrap();
        let gzip_path = root.path().join("assets/index-1234AbCd.js.gz");
        std::fs::write(&gzip_path, &good).unwrap();
        assert!(
            Assets::load(root.path())
                .unwrap()
                .get("/assets/index-1234AbCd.js")
                .unwrap()
                .gzip
                .is_some()
        );
        let mut corrupt = good;
        let n = corrupt.len();
        corrupt[n - 8] ^= 1;
        std::fs::write(&gzip_path, corrupt).unwrap();
        assert!(Assets::load(root.path()).is_err());
        std::fs::remove_file(gzip_path).unwrap();
        std::fs::write(root.path().join("assets/index.js.map"), "{}").unwrap();
        assert!(Assets::load(root.path()).is_err());
    }
}
