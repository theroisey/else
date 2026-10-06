//! Stored identity syntax is separate from HTTPS egress and ownership proof.
use url::{Host, Url};

pub fn valid_account(provider: &str, raw: &str) -> bool {
    match provider {
        "ga4" | "meta_ads" => {
            !raw.is_empty()
                && raw.len() <= if provider == "ga4" { 20 } else { 32 }
                && raw.as_bytes()[0] != b'0'
                && raw.bytes().all(|b| b.is_ascii_digit())
        }
        "woocommerce" => store(raw),
        _ => false,
    }
}
pub fn store(raw: &str) -> bool {
    if !raw.is_ascii()
        || raw.len() > 520
        || !raw.starts_with("https://")
        || raw.ends_with('/')
        || raw.contains(['%', '\\', '?', '#'])
    {
        return false;
    }
    let Ok(parsed) = Url::parse(raw) else {
        return false;
    };
    let Some(Host::Domain(host)) = parsed.host() else {
        return false;
    };
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || host.len() > 253
        || !host.contains('.')
        || host
            .rsplit('.')
            .next()
            .is_none_or(|tld| !tld.as_bytes().first().is_some_and(u8::is_ascii_lowercase))
    {
        return false;
    }
    if !host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }) {
        return false;
    }
    let path = parsed.path();
    if path.len() > 256
        || (path != "/"
            && !path
                .strip_prefix('/')
                .unwrap_or("")
                .split('/')
                .all(|segment| {
                    !segment.is_empty()
                        && segment
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                }))
    {
        return false;
    }
    parsed.as_str().trim_end_matches('/') == raw
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_preserves_the_narrow_immutable_identities() {
        for good in [
            "https://shop.example.com",
            "https://shop.example.com/wordpress_store",
        ] {
            assert!(store(good));
        }
        for bad in [
            "https://shop.example.com/",
            "https://shop.example.com:443",
            "https://shop.example.com/../wp",
            "https://shop.example.com/wp//shop",
            "https://127.0.0.1",
            "https://shop.123",
            "https://USER:SECRET@shop.example.com",
            "https://shop.example.com?",
            "https://SHOP.example.com",
        ] {
            assert!(!store(bad), "{bad}");
        }
        assert!(valid_account("meta_ads", &"1".repeat(32)));
        assert!(!valid_account("ga4", &"1".repeat(21)));
        assert!(!valid_account("ga4", "01"));
    }
}
