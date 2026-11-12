//! What a TLS Secret says about itself — and the one thing it must never say.
//!
//! A certificate carries its own validity. `tls.crt` is a PEM chain the app
//! can read without help from anything outside the cluster, which is why
//! expiry is a core fact here and not something an extension grants.
//!
//! The parsing happens in this process on purpose. The webview needs six
//! short strings; it does not need a certificate, and it must never be
//! handed the private key sitting in the next key of the same Secret.

use std::collections::BTreeMap;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use serde::{Deserialize, Serialize};
use x509_parser::prelude::*;

/// What one certificate states about itself.
///
/// Times are RFC 3339 so the reader's clock decides how long is left — a
/// "days remaining" computed here would be stale by the time it is drawn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateFacts {
    /// The subject common name, where there is one. Modern certificates
    /// often have none and say everything in the SANs instead.
    pub subject: Option<String>,
    /// The issuer as a person recognises it: the organisation with the
    /// intermediate's code beside it — "Google Trust Services (WR1)" — or
    /// whichever half the certificate carries. A public CA's issuer CN is a
    /// cryptic code on its own, and "issued by WR1" answered nothing.
    pub issuer: Option<String>,
    /// Every name this certificate is valid for, from the SAN extension.
    pub dns_names: Vec<String>,
    pub not_before: String,
    pub not_after: String,
    pub serial: String,
    /// Subject equals issuer: nothing above it vouched for this.
    pub self_signed: bool,
    /// How many certificates were in the bundle. Only the leaf is described;
    /// the rest are the chain to the root.
    pub chain_length: usize,
}

/// Why there is nothing to say about a Secret's certificate.
///
/// Stated rather than left blank: "this Ingress has no readable certificate"
/// and "the app did not look" are different claims, and only one of them
/// belongs to the app.
///
/// Named rather than written, because the reader's language is not in scope
/// here and never can be — this runs in the backend, before anything knows
/// who is reading. The two variants that quote the API server carry its
/// words untouched; the rest are the app's own sentence and it is the
/// frontend that chooses it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum CertificateProblem {
    /// The namespace has no Secret of that name.
    NoSecret,
    /// The Secret exists and the API server refused or failed the read.
    SecretUnreadable { said: String },
    /// A Secret with no `tls.crt` key in it.
    NoTlsCrt,
    /// A `tls.crt` with no PEM certificate anywhere in it — a key on its
    /// own, most often.
    NoPemCertificate,
    /// PEM that is not a certificate this app can parse.
    Unparseable { said: String },
}

/// Read the leaf certificate out of a PEM bundle.
///
/// The leaf is the first certificate in `tls.crt` — that is the order TLS
/// itself requires, so it is a fact rather than a guess.
///
/// # Errors
/// Returns a sentence naming what the bytes were instead of a certificate.
pub fn read_certificate(pem_bytes: &[u8]) -> Result<CertificateFacts, CertificateProblem> {
    let mut blocks = Vec::new();
    for block in x509_parser::pem::Pem::iter_from_buffer(pem_bytes) {
        match block {
            Ok(block) if block.label == "CERTIFICATE" => blocks.push(block),
            // A bundle that ends in trailing whitespace or a comment is
            // normal; only a total absence of certificates is a problem.
            _ => {}
        }
    }

    let Some(leaf) = blocks.first() else {
        return Err(CertificateProblem::NoPemCertificate);
    };

    let (_, cert) = X509Certificate::from_der(&leaf.contents).map_err(|err| {
        CertificateProblem::Unparseable {
            said: err.to_string(),
        }
    })?;

    let subject = first_common_name(cert.subject());
    let issuer = issuer_name(cert.issuer());
    let dns_names = cert
        .subject_alternative_name()
        .ok()
        .flatten()
        .map(|san| {
            san.value
                .general_names
                .iter()
                .filter_map(|name| match name {
                    GeneralName::DNSName(dns) => Some((*dns).to_string()),
                    GeneralName::IPAddress(bytes) => Some(format_ip(bytes)),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(CertificateFacts {
        subject,
        issuer,
        dns_names,
        not_before: rfc3339(cert.validity().not_before.timestamp()),
        not_after: rfc3339(cert.validity().not_after.timestamp()),
        serial: cert.raw_serial_as_string(),
        self_signed: cert.subject() == cert.issuer(),
        chain_length: blocks.len(),
    })
}

/// An X.509 timestamp in the one format the rest of the app speaks.
///
/// A certificate outside the range `chrono` can represent is corrupt in a
/// way no reader can act on, so it reads as the epoch rather than costing
/// the whole parse.
fn rfc3339(seconds: i64) -> String {
    chrono::DateTime::from_timestamp(seconds, 0)
        .unwrap_or_default()
        .to_rfc3339()
}

/// The organisation with the CN's code beside it, or whichever half exists.
fn issuer_name(name: &X509Name) -> Option<String> {
    let organisation = name
        .iter_organization()
        .next()
        .and_then(|entry| entry.as_str().ok())
        .map(str::to_string)
        .filter(|value| !value.is_empty());
    let code = first_common_name(name);
    match (organisation, code) {
        (Some(organisation), Some(code)) if organisation != code => {
            Some(format!("{organisation} ({code})"))
        }
        (Some(organisation), _) => Some(organisation),
        (None, code) => code,
    }
}

fn first_common_name(name: &X509Name) -> Option<String> {
    name.iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .map(str::to_string)
        .filter(|cn| !cn.is_empty())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn format_ip(bytes: &[u8]) -> String {
    match bytes.len() {
        4 => bytes
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("."),
        16 => {
            let groups: Vec<String> = bytes
                .chunks(2)
                .map(|pair| format!("{:x}", u16::from(pair[0]) << 8 | u16::from(pair[1])))
                .collect();
            groups.join(":")
        }
        // Neither 4 nor 16 bytes is not a length any address has, and the
        // bytes themselves say more than a sentence about them would — and
        // say it in every language.
        _ => format!("0x{}", hex(bytes)),
    }
}

// --- the rule a private key never leaves this process --------------------

/// The key each built-in Secret type declares to be a private key.
///
/// This is the API server's own contract rather than the app's guess: a
/// Secret of type `kubernetes.io/tls` is rejected at admission unless it
/// carries `tls.key`, and what that key holds is not open to interpretation.
fn key_declared_private(secret_type: &str, key: &str) -> bool {
    match secret_type {
        "kubernetes.io/tls" => key == "tls.key",
        "kubernetes.io/ssh-auth" => key == "ssh-privatekey",
        _ => false,
    }
}

/// Names that exist to hold a private key.
///
/// The weakest net and never the only one — a Secret is a free-form map and
/// nothing stops a key called `notes` from holding a PEM key, which is what
/// the content test is for. This one earns its place at the other end: bytes
/// no parser here can classify, sitting under a name that says outright what
/// they are.
const PRIVATE_KEY_NAMES: &[&str] = &[
    "tls.key",
    "ssh-privatekey",
    "key.pem",
    "server.key",
    "client.key",
    "privatekey",
    "private-key",
    "private.key",
];

/// Which net caught a withheld value, worded by the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Withheld {
    /// The bytes are a private key, whatever the key is called.
    PrivateKey,
    /// The Secret's `type` names this key as its private key.
    Declared { by: String },
    /// A key name that exists to hold a private key.
    KeyName,
    /// The Helm release this Secret stores has something withheld in it.
    HelmRelease,
}

/// Why a Secret value is withheld, or `None` where it is safe to hand over.
///
/// Three nets, because no one of them is enough on its own:
///
/// 1. **What the value says it is.** A PEM block labelled `… PRIVATE KEY`,
///    or bytes `rustls-pemfile` decodes to a PKCS#1, PKCS#8 or SEC1 key.
///    This is the only net that works whatever the key is called, and it
///    catches an encrypted or OpenSSH key that no decoder here handles.
/// 2. **What the Secret's type declares.** Authoritative, and it holds for
///    bytes the first net cannot read — a DER key, or a value that failed
///    to base64-decode.
/// 3. **The key's name.** For everything outside a built-in type. Heuristic
///    on its own, which is exactly why it is third and not alone.
///
/// Withholding is one-way: a value that trips any net is never returned, so
/// nothing downstream has to remember not to render it.
#[must_use]
pub fn withhold_reason(secret_type: &str, key: &str, value: &[u8]) -> Option<Withheld> {
    // The PEM label says which flavour it is — RSA, EC, encrypted — and
    // none of that changes what the reader can do, so the row does not
    // carry it.
    if says_private_key(value) {
        return Some(Withheld::PrivateKey);
    }
    // Helm keeps a release whole in a Secret of this type: the key its page
    // withholds would be one `base64 -d | gunzip` away on this one.
    if secret_type == HELM_RELEASE_TYPE && super::helm::stored_release_withholds(value) {
        return Some(Withheld::HelmRelease);
    }
    if key_declared_private(secret_type, key) {
        return Some(Withheld::Declared {
            by: secret_type.to_string(),
        });
    }
    if PRIVATE_KEY_NAMES.contains(&key.to_ascii_lowercase().as_str()) {
        return Some(Withheld::KeyName);
    }
    None
}

/// The type of the Secret Helm stores one revision of a release in.
const HELM_RELEASE_TYPE: &str = "helm.sh/release.v1";

/// The first net on its own: what the bytes say they are.
fn says_private_key(value: &[u8]) -> bool {
    has_pem_private_key_label(value) || decodes_as_private_key(value)
}

/// The first net for a string no map names: a private key as text, or as
/// the base64 of one, wrapped the way `base64` prints it or not.
pub(super) fn is_private_key_text(text: &str) -> bool {
    use base64::Engine;
    if says_private_key(text.as_bytes()) {
        return true;
    }
    let packed: String = text.split_whitespace().collect();
    base64::engine::general_purpose::STANDARD
        .decode(packed)
        .is_ok_and(|bytes| says_private_key(&bytes))
}

/// Whether the value carries a PEM block whose own label says private key.
///
/// Read off the raw text rather than through a decoder: an encrypted or
/// unfamiliar key type is one no parser here handles and exactly the one
/// worth withholding. The label is looked for anywhere, not at the start of
/// a line: a service-account file keeps its key in one JSON string, with the
/// line breaks written as `\n`.
fn has_pem_private_key_label(value: &[u8]) -> bool {
    let text = String::from_utf8_lossy(value);
    text.match_indices("-----BEGIN ").any(|(at, begin)| {
        let rest = &text[at + begin.len()..];
        rest.find("-----").is_some_and(|end| {
            let label = &rest[..end];
            label.len() <= 40
                && !label.contains('\n')
                && label.to_ascii_uppercase().contains("PRIVATE KEY")
        })
    })
}

fn decodes_as_private_key(value: &[u8]) -> bool {
    let mut reader = std::io::BufReader::new(value);
    let found = rustls_pemfile::read_all(&mut reader).any(|item| {
        matches!(
            item,
            Ok(rustls_pemfile::Item::Pkcs1Key(_)
                | rustls_pemfile::Item::Pkcs8Key(_)
                | rustls_pemfile::Item::Sec1Key(_))
        )
    });
    found
}

/// What replaces a private key in a rendered manifest.
///
/// Not valid base64, so the API server refuses it in a Secret's `data`. A
/// `ConfigMap`'s `data` is plain text and takes it as the new value, which
/// is why [`still_withheld`] is asked before a manifest is sent anywhere.
/// `src/contracts/withheld-value.json` holds the frontend to the same text.
pub const WITHHELD_MARKER: &str = "<withheld: the app never shows a private key>";

/// The maps a private key can sit in, and whether each is base64.
pub(super) const KEY_MAPS: [(&str, bool); 3] =
    [("data", true), ("binaryData", true), ("stringData", false)];

/// The keys of a manifest that still hold [`WITHHELD_MARKER`]: applied as it
/// is, the placeholder would be written over each of them.
#[must_use]
pub fn still_withheld(object: &serde_json::Value) -> Vec<String> {
    KEY_MAPS
        .iter()
        .filter_map(|(field, _)| object.get(field)?.as_object())
        .flatten()
        .filter(|(_, value)| value.as_str().is_some_and(|v| v.trim() == WITHHELD_MARKER))
        .map(|(key, _)| key.clone())
        .collect()
}

/// The keys still blanked inside an annotation's value, where that value is
/// a record [`redact_private_keys`] blanked for the screen. Sent back, the
/// placeholder would replace what the tool that keeps the record wrote.
#[must_use]
pub fn withheld_copy(value: &str) -> Vec<String> {
    let Some(object) = embedded_object(value) else {
        return Vec::new();
    };
    let mut keys = still_withheld(&object);
    let nested = object
        .pointer("/metadata/annotations")
        .and_then(serde_json::Value::as_object);
    keys.extend(
        nested
            .into_iter()
            .flat_map(|map| map.values())
            .filter_map(serde_json::Value::as_str)
            .flat_map(withheld_copy),
    );
    keys
}

/// Blank every private key in a rendered object, in place.
///
/// Applied to the YAML paths as well as the decoded-values path, because
/// base64 is not a control: `tls.key` in a manifest is one `base64 -d` from
/// being the key, and the rule is that the app never renders one.
///
/// Not gated on the kind. A `data` map holding a PEM private key is a leak
/// whether the object calls itself a Secret or not, and `kind` is a field
/// the app would have to trust the response to carry. `binaryData` is walked
/// for the same reason: it is a `ConfigMap`'s base64 map, and a key put there
/// is no less a key than one in `data`.
///
/// An annotation that holds a whole object as JSON is judged the same way:
/// `kubectl apply` records the manifest it sent under one, and with it a
/// second copy of every key these maps hold.
///
/// Returns the keys it blanked, each once, so the surface can say what is
/// missing rather than leaving the reader to notice.
pub fn redact_private_keys(object: &mut serde_json::Value) -> Vec<String> {
    let mut blanked = redact_key_maps(object);
    let annotations = object
        .pointer_mut("/metadata/annotations")
        .and_then(serde_json::Value::as_object_mut);
    for value in annotations.into_iter().flat_map(|map| map.values_mut()) {
        if let Some((shown, keys)) = value.as_str().and_then(redact_embedded) {
            *value = serde_json::Value::String(shown);
            blanked.extend(keys);
        }
    }
    let mut seen = std::collections::HashSet::new();
    blanked.retain(|key| seen.insert(key.clone()));
    blanked
}

/// A record's text names a key map only with one of these in it: the name's
/// own letters, or the one escape JSON can spell a letter with. A record
/// inside a record keeps them under its added backslashes. The few kilobytes
/// every applied Deployment carries have none, and are never parsed.
const SPELLS_A_KEY_MAP: [&str; 3] = ["\"data", "Data", "\\u"];

/// The object an annotation's value is, where it is one written as JSON
/// that could hold a key map.
fn embedded_object(text: &str) -> Option<serde_json::Value> {
    (text.trim_start().starts_with('{') && SPELLS_A_KEY_MAP.iter().any(|sign| text.contains(sign)))
        .then(|| serde_json::from_str(text).ok())
        .flatten()
}

/// An annotation's value with the private keys of the object it holds
/// blanked, and which. `None` where it holds no object or nothing in it was
/// blanked: that value is left byte for byte.
fn redact_embedded(text: &str) -> Option<(String, Vec<String>)> {
    let mut object = embedded_object(text)?;
    let keys = redact_private_keys(&mut object);
    if keys.is_empty() {
        return None;
    }
    // kubectl ends its record with a newline, and the YAML keeps its shape.
    let tail = &text[text.trim_end().len()..];
    Some((format!("{object}{tail}"), keys))
}

/// An object's annotations as they may leave this process. Every wire type
/// that carries annotations is filled from here, which a guard in `main.rs`
/// holds.
#[must_use]
pub fn annotations_of(meta: &ObjectMeta) -> BTreeMap<String, String> {
    let shown =
        |value: &String| redact_embedded(value).map_or_else(|| value.clone(), |(shown, _)| shown);
    meta.annotations
        .iter()
        .flatten()
        .map(|(key, value)| (key.clone(), shown(value)))
        .collect()
}

/// An object whole, as it may leave this process.
///
/// # Errors
///
/// If the object does not serialise.
pub fn shown<T: Serialize>(object: &T) -> serde_json::Result<serde_json::Value> {
    let mut value = serde_json::to_value(object)?;
    redact_private_keys(&mut value);
    Ok(value)
}

fn redact_key_maps(object: &mut serde_json::Value) -> Vec<String> {
    let secret_type = object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();

    let mut blanked = Vec::new();
    for (field, base64_encoded) in KEY_MAPS {
        let Some(map) = object
            .get_mut(field)
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        for (key, value) in map.iter_mut() {
            let Some(text) = value.as_str() else { continue };
            let bytes = if base64_encoded {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD
                    .decode(text)
                    .unwrap_or_else(|_| text.as_bytes().to_vec())
            } else {
                text.as_bytes().to_vec()
            };
            if withhold_reason(&secret_type, key, &bytes).is_some() {
                *value = serde_json::Value::String(WITHHELD_MARKER.to_string());
                blanked.push(key.clone());
            }
        }
    }
    blanked
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real self-signed leaf, generated once and pinned here so the parse
    /// is tested against bytes rather than against a mock.
    ///
    /// CN=shop.example.com, SANs shop.example.com and www.shop.example.com,
    /// valid 2026-01-01 .. 2036-01-01.
    const LEAF_PEM: &str = include_str!("../../tests/fixtures/leaf.crt.pem");
    const KEY_PEM: &str = include_str!("../../tests/fixtures/leaf.key.pem");

    /// Would break if the leaf's own words stopped reaching the reader —
    /// the whole point of parsing here rather than shipping the bytes out.
    #[test]
    fn a_certificate_states_its_own_names_and_validity() {
        let facts = read_certificate(LEAF_PEM.as_bytes()).expect("parse");
        assert_eq!(facts.subject.as_deref(), Some("shop.example.com"));
        assert_eq!(
            facts.dns_names,
            vec![
                "shop.example.com".to_string(),
                "www.shop.example.com".to_string()
            ]
        );
        assert!(facts.not_after.starts_with("2036-"));
        assert!(facts.self_signed);
        assert_eq!(facts.chain_length, 1);
    }

    /// The issuer a public CA actually writes: a cryptic intermediate CN —
    /// WR1, R11, E5 — beside the organisation a person recognises. Would
    /// break if the row went back to printing the code alone, which is what
    /// "issued by WR1" was.
    const ORG_ISSUER_PEM: &str = include_str!("../../tests/fixtures/issuer-org.crt.pem");

    #[test]
    fn an_issuer_names_its_organisation_over_its_code() {
        let facts = read_certificate(ORG_ISSUER_PEM.as_bytes()).expect("parse");
        assert_eq!(
            facts.issuer.as_deref(),
            Some("Example Trust Services (XR1)")
        );
    }

    /// Would break if a Secret whose `tls.crt` is something else were
    /// reported as a certificate rather than as a stated problem.
    #[test]
    fn bytes_that_are_not_a_certificate_say_so() {
        assert!(read_certificate(b"not a certificate").is_err());
        assert!(read_certificate(KEY_PEM.as_bytes()).is_err());
    }

    /// Would break if a private key became renderable, or if the reason the
    /// screen words stopped naming the net that caught it. Each assertion is
    /// one of the three nets on its own, so removing any one of them fails here.
    #[test]
    fn a_private_key_is_never_handed_over() {
        // 1 — what the value says it is, under a name that says nothing.
        assert_eq!(
            withhold_reason("Opaque", "notes", KEY_PEM.as_bytes()),
            Some(Withheld::PrivateKey)
        );
        // 2 — what the type declares, for bytes the first net cannot read.
        assert_eq!(
            withhold_reason("kubernetes.io/tls", "tls.key", &[0x30, 0x82, 0x04, 0xa4]),
            Some(Withheld::Declared {
                by: "kubernetes.io/tls".into()
            })
        );
        assert!(withhold_reason("kubernetes.io/ssh-auth", "ssh-privatekey", b"").is_some());
        // 3 — the name, outside any built-in type.
        assert_eq!(
            withhold_reason("Opaque", "server.key", &[0x30, 0x82]),
            Some(Withheld::KeyName)
        );
    }

    /// Would break if the rule started swallowing values it has no business
    /// hiding — a Secret whose keys are all withheld is a page that lies.
    #[test]
    fn a_certificate_and_a_password_are_still_handed_over() {
        assert_eq!(
            withhold_reason("kubernetes.io/tls", "tls.crt", LEAF_PEM.as_bytes()),
            None
        );
        assert_eq!(withhold_reason("Opaque", "password", b"hunter2"), None);
        assert_eq!(
            withhold_reason("Opaque", "ca.crt", LEAF_PEM.as_bytes()),
            None
        );
    }

    /// Helm keeps a release whole in a Secret, as base64 over gzip: the key
    /// its page withholds was one `base64 -d | gunzip` away on the Secret's.
    /// Fails if the stored release is handed over while its values, its
    /// manifest or a file of its chart holds a key, or withheld while none
    /// does.
    #[test]
    fn the_secret_a_helm_release_is_stored_in_does_not_hand_over_the_releases_key() {
        use base64::Engine;
        use std::io::Write as _;
        const TYPE: &str = "helm.sh/release.v1";
        let base64 = base64::engine::general_purpose::STANDARD;
        let stored = |release: &serde_json::Value| {
            let mut gzip =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            gzip.write_all(release.to_string().as_bytes()).unwrap();
            base64.encode(gzip.finish().unwrap()).into_bytes()
        };
        let secret = |key: &str, value: &str| {
            format!(
                "apiVersion: v1\nkind: Secret\nmetadata:\n  name: web\ndata:\n  {key}: {value}\n"
            )
        };
        let release = |values: serde_json::Value, manifest: &str, file: &str| {
            serde_json::json!({
                "name": "web", "version": 1, "config": values, "manifest": manifest,
                "info": { "status": "deployed", "notes": "1. Get the URL" },
                "chart": { "files": [{ "name": "files/id", "data": base64.encode(file) }] },
            })
        };
        let clean = release(
            serde_json::json!({ "password": "hunter2" }),
            &secret("ca.crt", &base64.encode(LEAF_PEM)),
            "README",
        );
        let holding = [
            release(serde_json::json!({ "tls": { "key": KEY_PEM } }), "", ""),
            release(
                serde_json::json!({}),
                &secret("blob", &base64.encode(KEY_PEM)),
                "",
            ),
            release(serde_json::json!({}), "", KEY_PEM),
        ];

        for release in &holding {
            assert_eq!(
                withhold_reason(TYPE, "release", &stored(release)),
                Some(Withheld::HelmRelease),
                "{release}"
            );
        }
        assert_eq!(withhold_reason(TYPE, "release", &stored(&clean)), None);
        // Before Helm 3 gzipped it, and bytes that are no release at all.
        let plain = base64.encode(holding[0].to_string()).into_bytes();
        assert!(withhold_reason(TYPE, "release", &plain).is_some());
        assert_eq!(withhold_reason(TYPE, "release", b"not a release"), None);

        // The YAML tab of the same Secret, where `data` is base64 once more.
        let mut object = serde_json::json!({
            "kind": "Secret",
            "type": TYPE,
            "data": { "release": base64.encode(stored(&holding[1])) },
        });
        assert_eq!(redact_private_keys(&mut object), vec!["release"]);
        assert_eq!(object["data"]["release"], WITHHELD_MARKER);
    }

    /// Would break if the YAML tab started rendering `tls.key` again — the
    /// path the decoded-values rule does not cover, and the one a reader
    /// reaches for when the value is hidden elsewhere.
    #[test]
    fn a_manifest_never_carries_the_private_key() {
        use base64::Engine;
        let encode = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);
        let mut object = serde_json::json!({
            "kind": "Secret",
            "type": "kubernetes.io/tls",
            "data": { "tls.crt": encode(LEAF_PEM), "tls.key": encode(KEY_PEM) },
        });

        assert_eq!(
            redact_private_keys(&mut object),
            vec!["tls.key".to_string()]
        );
        assert_eq!(object["data"]["tls.key"], WITHHELD_MARKER);
        assert_eq!(object["data"]["tls.crt"], encode(LEAF_PEM));
        // Not valid base64, so an edited copy is refused rather than applied.
        assert!(base64::engine::general_purpose::STANDARD
            .decode(WITHHELD_MARKER)
            .is_err());
    }

    /// A `ConfigMap` is not a Secret, but people paste keys into them, and its
    /// YAML tab goes through the same door. No `type` field to lean on, and
    /// `binaryData` rather than `data` — both of which used to be a way past.
    #[test]
    fn a_configmap_never_carries_the_private_key_either() {
        use base64::Engine;
        let encode = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);
        let mut object = serde_json::json!({
            "kind": "ConfigMap",
            "data": { "server.key": KEY_PEM, "app.conf": "log_level = debug" },
            "binaryData": { "bundle.p12": encode(KEY_PEM) },
        });

        let mut blanked = redact_private_keys(&mut object);
        blanked.sort();
        assert_eq!(blanked, vec!["bundle.p12", "server.key"]);
        assert_eq!(object["data"]["server.key"], WITHHELD_MARKER);
        assert_eq!(object["binaryData"]["bundle.p12"], WITHHELD_MARKER);
        assert_eq!(object["data"]["app.conf"], "log_level = debug");
    }

    const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

    fn encoded(text: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    /// An object as `kubectl apply` leaves it: its record of `applied` in
    /// the annotation, newline and all.
    fn applied(mut live: serde_json::Value, applied: &serde_json::Value) -> serde_json::Value {
        live["metadata"]["annotations"][LAST_APPLIED] = format!("{applied}\n").into();
        live
    }

    fn record_of(object: &serde_json::Value) -> serde_json::Value {
        let text = object["metadata"]["annotations"][LAST_APPLIED]
            .as_str()
            .expect("the annotation");
        serde_json::from_str(text).expect("still JSON")
    }

    /// `kubectl apply` keeps the manifest it sent in an annotation, so the
    /// key withheld under `data` was on screen in full three lines lower.
    /// Fails if the record is not judged, stops being JSON, or the one key
    /// is named twice.
    /// A cloud service-account file is JSON with the key in one string, its
    /// line breaks written as `\n`, so no line of it starts with the label.
    /// Fails if such a file is handed over because the label was mid-line.
    #[test]
    fn a_key_kept_inside_a_json_file_is_withheld_like_any_other() {
        let file = concat!(
            r#"{"type":"service_account","project_id":"demo","#,
            r#""private_key":"-----BEGIN PRIVATE KEY-----\nTUFERS1VUC1LRVk=\n-----END PRIVATE KEY-----\n","#,
            r#""client_email":"demo@demo.iam.example"}"#
        );
        assert_eq!(
            withhold_reason("Opaque", "key.json", file.as_bytes()),
            Some(Withheld::PrivateKey)
        );
        let mentioned = "see RFC 7468 for the -----BEGIN CERTIFICATE----- label";
        assert_eq!(
            withhold_reason("Opaque", "notes", mentioned.as_bytes()),
            None
        );
    }

    #[test]
    fn the_record_kubectl_keeps_of_a_configmap_does_not_carry_the_key() {
        let manifest = serde_json::json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "nginx", "namespace": "team-a" },
            "data": { "nginx.conf": "worker_processes 2;", "server.key": KEY_PEM },
        });
        let mut object = applied(manifest.clone(), &manifest);

        assert_eq!(redact_private_keys(&mut object), vec!["server.key"]);

        let record = record_of(&object);
        assert_eq!(record["data"]["server.key"], WITHHELD_MARKER);
        assert_eq!(record["data"]["nginx.conf"], "worker_processes 2;");
        assert_eq!(record["metadata"], manifest["metadata"]);
        let text = object["metadata"]["annotations"][LAST_APPLIED].as_str();
        assert!(text.is_some_and(|text| text.ends_with("}\n")));
        assert!(!object.to_string().contains("PRIVATE KEY"));
    }

    /// A Secret applied from a file has its `tls.key` in the record as
    /// base64, one `base64 -d` from the key. The second Secret is caught by
    /// what its bytes are, under a name and a type that say nothing.
    #[test]
    fn the_record_of_a_secret_does_not_carry_the_key_in_base64() {
        let tls = serde_json::json!({
            "kind": "Secret",
            "type": "kubernetes.io/tls",
            "metadata": { "name": "tls" },
            "data": { "tls.crt": encoded(LEAF_PEM), "tls.key": encoded(KEY_PEM) },
        });
        let mut object = applied(tls.clone(), &tls);
        assert_eq!(redact_private_keys(&mut object), vec!["tls.key"]);
        assert_eq!(record_of(&object)["data"]["tls.key"], WITHHELD_MARKER);
        assert_eq!(record_of(&object)["data"]["tls.crt"], encoded(LEAF_PEM));
        assert!(!object.to_string().contains(&encoded(KEY_PEM)));

        let opaque = serde_json::json!({
            "kind": "Secret",
            "metadata": { "name": "notes" },
            "data": { "notes": encoded(KEY_PEM) },
        });
        let mut object = applied(opaque.clone(), &opaque);
        assert_eq!(redact_private_keys(&mut object), vec!["notes"]);
        assert!(!object.to_string().contains(&encoded(KEY_PEM)));
    }

    /// `stringData` is written once and never read back, so the live Secret
    /// has only `data` while the record still has the key as plain text.
    #[test]
    fn the_record_of_a_secret_does_not_carry_the_key_it_was_given_as_text() {
        let live = serde_json::json!({
            "kind": "Secret",
            "metadata": { "name": "deploy" },
            "data": { "user": encoded("git") },
        });
        let manifest = serde_json::json!({
            "kind": "Secret",
            "metadata": { "name": "deploy" },
            "stringData": { "user": "git", "id_rsa": KEY_PEM },
        });
        let mut object = applied(live, &manifest);

        assert_eq!(redact_private_keys(&mut object), vec!["id_rsa"]);
        assert_eq!(record_of(&object)["stringData"]["id_rsa"], WITHHELD_MARKER);
        assert_eq!(record_of(&object)["stringData"]["user"], "git");
        assert!(!object.to_string().contains("PRIVATE KEY"));
    }

    /// Would rewrite, or drop, an annotation the rule has no business in:
    /// one that is not JSON, one that is JSON and not an object, and a
    /// record with no key in it, which comes through byte for byte.
    #[test]
    fn an_annotation_with_no_key_in_it_is_left_as_it_was_written() {
        let record = "{ \"kind\":\"ConfigMap\", \"data\":{\"b\":\"2\",\"a\":\"1\"} }\n";
        let mut object = serde_json::json!({
            "kind": "ConfigMap",
            "metadata": { "annotations": {
                LAST_APPLIED: record,
                "note": "{not json: server.key",
                "list": "[{\"data\":{\"server.key\":\"x\"}}]",
                "word": "\"server.key\"",
            } },
            "data": { "a": "1", "b": "2" },
        });
        let before = object.clone();

        assert!(redact_private_keys(&mut object).is_empty());
        assert_eq!(object, before);
        assert_eq!(object["metadata"]["annotations"][LAST_APPLIED], record);
    }

    /// A record with no key map in it is not parsed, and is told from one
    /// that has by its text. JSON lets a name be spelled with escapes, and a
    /// record that spelled `data` that way would be waved through whole.
    #[test]
    fn a_key_map_spelled_with_an_escape_is_still_a_key_map() {
        let record = serde_json::json!({ "data": { "server.key": KEY_PEM } });
        let escaped = record.to_string().replace("\"data\"", "\"d\\u0061ta\"");
        assert!(escaped.contains("\\u0061") && !escaped.contains("\"data"));
        let mut object = serde_json::json!({
            "kind": "ConfigMap",
            "metadata": { "annotations": { LAST_APPLIED: escaped } },
        });

        assert_eq!(redact_private_keys(&mut object), vec!["server.key"]);
        assert_eq!(record_of(&object)["data"]["server.key"], WITHHELD_MARKER);
        assert!(!object.to_string().contains("PRIVATE KEY"));
    }

    /// One tool's record can hold an object that carries another's, and a
    /// key two records deep is as readable as one.
    #[test]
    fn a_record_inside_a_record_is_judged_too() {
        let inner = serde_json::json!({ "kind": "ConfigMap", "data": { "client.key": KEY_PEM } });
        let outer = applied(serde_json::json!({ "kind": "ConfigMap" }), &inner);
        let mut object = applied(serde_json::json!({ "kind": "ConfigMap" }), &outer);

        assert_eq!(redact_private_keys(&mut object), vec!["client.key"]);
        assert_eq!(
            record_of(&record_of(&object))["data"]["client.key"],
            WITHHELD_MARKER
        );
        assert!(!object.to_string().contains("PRIVATE KEY"));
    }

    /// The typed builders hand annotations out as a map and never see the
    /// rendered object: the Metadata tab and the peek draw this map.
    #[test]
    fn the_annotations_a_builder_hands_out_do_not_carry_the_key() {
        let manifest =
            serde_json::json!({ "kind": "ConfigMap", "data": { "server.key": KEY_PEM } });
        let meta = ObjectMeta {
            annotations: Some(BTreeMap::from([
                (LAST_APPLIED.to_string(), format!("{manifest}\n")),
                ("team".to_string(), "edge".to_string()),
            ])),
            ..ObjectMeta::default()
        };

        let handed = annotations_of(&meta);
        let record: serde_json::Value = serde_json::from_str(&handed[LAST_APPLIED]).expect("JSON");
        assert_eq!(record["data"]["server.key"], WITHHELD_MARKER);
        assert!(!handed[LAST_APPLIED].contains("PRIVATE KEY"));
        assert_eq!(handed["team"], "edge");
        assert!(annotations_of(&ObjectMeta::default()).is_empty());
    }

    /// The generic object page and the peek take the object whole, as JSON.
    #[test]
    fn an_object_handed_over_whole_does_not_carry_the_key() {
        let secret: k8s_openapi::api::core::v1::Secret = serde_json::from_value(applied(
            serde_json::json!({
                "metadata": { "name": "tls" },
                "type": "kubernetes.io/tls",
                "data": { "tls.key": encoded(KEY_PEM) },
            }),
            &serde_json::json!({ "stringData": { "tls.key": KEY_PEM } }),
        ))
        .expect("a Secret");

        let whole = shown(&secret).expect("serialises");
        assert_eq!(whole["data"]["tls.key"], WITHHELD_MARKER);
        assert_eq!(record_of(&whole)["stringData"]["tls.key"], WITHHELD_MARKER);
        assert!(!whole.to_string().contains("PRIVATE KEY"));
        assert!(!whole.to_string().contains(&encoded(KEY_PEM)));
    }
}
