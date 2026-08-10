//! The one door a ConfigMap's or a Secret's values come through.
//!
//! Both kinds hold arbitrary bytes under string keys, and both are read by
//! the same component, so both are decoded by the same code. Withholding and
//! binary detection live here rather than in either command, because a rule
//! that has to be remembered twice is a rule that will be applied once.

use base64::Engine;
use std::collections::BTreeMap;

/// A value that is not text, described rather than rendered.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryValue {
    pub bytes: usize,
    /// What `kubectl get -o jsonpath` would have handed over. Offered for
    /// copying because `base64 -d` is a real thing a reader does with it;
    /// never rendered as if it were the value.
    pub base64: String,
}

/// A ConfigMap's or a Secret's values, split by what can honestly be said
/// about each one.
///
/// Three maps rather than one with holes in it. A key absent because the
/// reader lacks access, a key absent because it is a private key, and a key
/// whose bytes are not text are three different facts, and the page says
/// which. Nothing appears in more than one map.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigData {
    pub values: BTreeMap<String, String>,
    /// Key to the reason it is withheld.
    pub withheld: BTreeMap<String, String>,
    /// Key to its size and base64, for bytes that are not UTF-8.
    pub binary: BTreeMap<String, BinaryValue>,
}

impl ConfigData {
    /// Sort one value into the map that tells the truth about it.
    ///
    /// Withholding first: a DER private key is also non-UTF-8, and "binary,
    /// 1.2 kB" would be a description of a key the app has promised not to
    /// describe.
    pub fn take(&mut self, secret_type: &str, key: String, value: &[u8]) {
        if let Some(reason) = crate::resources::withhold_reason(secret_type, &key, value) {
            self.withheld.insert(key, reason);
            return;
        }

        match text_of(value) {
            Some(text) => {
                self.values.insert(key, text);
            }
            None => {
                self.binary.insert(
                    key,
                    BinaryValue {
                        bytes: value.len(),
                        base64: base64::engine::general_purpose::STANDARD.encode(value),
                    },
                );
            }
        }
    }
}

/// The value as text, or `None` where calling it text would be a lie.
///
/// `from_utf8_lossy` was the old behaviour and it is the reason this exists:
/// a keystore came back as replacement characters that read exactly like a
/// value someone had typed, and copying it produced neither the bytes nor an
/// error. A NUL rules the bytes out too — it is valid UTF-8 and no one puts
/// one in a password.
fn text_of(value: &[u8]) -> Option<String> {
    if value.contains(&0) {
        return None;
    }
    String::from_utf8(value.to_vec()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_stays_text() {
        let mut data = ConfigData::default();
        data.take("Opaque", "password".into(), b"hunter2");
        assert_eq!(data.values.get("password").unwrap(), "hunter2");
        assert!(data.binary.is_empty());
        assert!(data.withheld.is_empty());
    }

    #[test]
    fn utf8_beyond_ascii_is_still_text() {
        let mut data = ConfigData::default();
        data.take("Opaque", "greeting".into(), "привет · ✓".as_bytes());
        assert_eq!(data.values.get("greeting").unwrap(), "привет · ✓");
        assert!(data.binary.is_empty());
    }

    #[test]
    fn invalid_utf8_is_described_not_mangled() {
        let mut data = ConfigData::default();
        let blob = [0x00, 0x01, 0x02, 0xff, 0xfe];
        data.take("Opaque", "blob".into(), &blob);

        assert!(
            !data.values.contains_key("blob"),
            "binary must never reach the values map, where it would render as text"
        );
        let described = data.binary.get("blob").expect("described as binary");
        assert_eq!(described.bytes, 5);
        assert_eq!(described.base64, "AAEC//4=");
        assert!(!described.base64.contains('\u{fffd}'));
    }

    #[test]
    fn embedded_nul_is_binary_even_though_it_is_valid_utf8() {
        let mut data = ConfigData::default();
        data.take("Opaque", "keystore".into(), b"PK\x03\x04\x00\x00");
        assert!(data.binary.contains_key("keystore"));
        assert!(!data.values.contains_key("keystore"));
    }

    /// A DER key is non-UTF-8, so the order of the two checks decides whether
    /// the page says "a private key" or leaks its size.
    #[test]
    fn withholding_wins_over_binary() {
        let mut data = ConfigData::default();
        data.take(
            "kubernetes.io/tls",
            "tls.key".into(),
            &[0x30, 0x82, 0x04, 0xa4, 0xff],
        );
        assert!(data.withheld.contains_key("tls.key"));
        assert!(!data.binary.contains_key("tls.key"));
        assert!(!data.values.contains_key("tls.key"));
    }

    /// The gap this closed: a ConfigMap has no `type`, so only the PEM label
    /// and the key-name nets can catch a key pasted into one.
    #[test]
    fn configmap_has_no_type_and_still_withholds_a_pem_key() {
        let mut data = ConfigData::default();
        data.take(
            "",
            "app.conf".into(),
            b"-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
        );
        assert!(data.withheld.contains_key("app.conf"));
        assert!(!data.values.contains_key("app.conf"));
    }
}
