//! What a TLS Secret says about itself — and the one thing it must never say.
//!
//! A certificate carries its own validity. `tls.crt` is a PEM chain the app
//! can read without help from anything outside the cluster, which is why
//! expiry is a core fact here and not something an extension grants.
//!
//! The parsing happens in this process on purpose. The webview needs six
//! short strings; it does not need a certificate, and it must never be
//! handed the private key sitting in the next key of the same Secret.

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
pub type CertificateProblem = String;

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
            _ => continue,
        }
    }

    let Some(leaf) = blocks.first() else {
        return Err("tls.crt holds no PEM certificate".to_string());
    };

    let (_, cert) = X509Certificate::from_der(&leaf.contents)
        .map_err(|err| format!("tls.crt is not a certificate the app can read: {err}"))?;

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
        _ => "an address the app cannot render".to_string(),
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
pub fn withhold_reason(secret_type: &str, key: &str, value: &[u8]) -> Option<String> {
    // The PEM label says which flavour it is — RSA, EC, encrypted — and
    // none of that changes what the reader can do, so the row does not
    // carry it. One sentence, whichever net caught the value.
    if has_pem_private_key_label(value) || decodes_as_private_key(value) {
        return Some("a private key — the app never shows one".to_string());
    }
    if key_declared_private(secret_type, key) {
        return Some(format!(
            "{secret_type} declares {key} to be the private key — the app never shows one"
        ));
    }
    if PRIVATE_KEY_NAMES.contains(&key.to_ascii_lowercase().as_str()) {
        return Some(format!(
            "{key} is where a private key lives — the app never shows one"
        ));
    }
    None
}

/// Whether the value carries a PEM block whose own label says private key.
///
/// Read off the raw text rather than through a decoder: an encrypted or
/// unfamiliar key type is one no parser here handles and exactly the one
/// worth withholding.
fn has_pem_private_key_label(value: &[u8]) -> bool {
    let text = String::from_utf8_lossy(value);
    text.lines().any(|line| {
        line.trim()
            .strip_prefix("-----BEGIN ")
            .and_then(|rest| rest.strip_suffix("-----"))
            .is_some_and(|label| label.to_ascii_uppercase().contains("PRIVATE KEY"))
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
/// Deliberately not valid base64. A reader who copies a Secret's YAML, edits
/// it and applies it would otherwise overwrite the real key with a
/// placeholder and take the service down; this way the API server rejects
/// the object and says why.
pub const WITHHELD_MARKER: &str = "<withheld — the app never shows a private key>";

/// Blank every private key in a rendered object, in place.
///
/// Applied to the YAML paths as well as the decoded-values path, because
/// base64 is not a control: `tls.key` in a manifest is one `base64 -d` from
/// being the key, and the rule is that the app never renders one.
///
/// Not gated on the kind. A `data` map holding a PEM private key is a leak
/// whether the object calls itself a Secret or not, and `kind` is a field
/// the app would have to trust the response to carry. `binaryData` is walked
/// for the same reason: it is a ConfigMap's base64 map, and a key put there
/// is no less a key than one in `data`.
///
/// Returns the keys it blanked, so the surface can say what is missing
/// rather than leaving the reader to notice.
pub fn redact_private_keys(object: &mut serde_json::Value) -> Vec<String> {
    let secret_type = object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();

    let mut blanked = Vec::new();
    for (field, base64_encoded) in [("data", true), ("binaryData", true), ("stringData", false)] {
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

    /// Would break if a private key became renderable. Each assertion is one
    /// of the three nets on its own, so removing any one of them fails here.
    #[test]
    fn a_private_key_is_never_handed_over() {
        // 1 — what the value says it is, under a name that says nothing.
        assert!(withhold_reason("Opaque", "notes", KEY_PEM.as_bytes()).is_some());
        // 2 — what the type declares, for bytes the first net cannot read.
        assert!(
            withhold_reason("kubernetes.io/tls", "tls.key", &[0x30, 0x82, 0x04, 0xa4]).is_some()
        );
        assert!(withhold_reason("kubernetes.io/ssh-auth", "ssh-privatekey", b"").is_some());
        // 3 — the name, outside any built-in type.
        assert!(withhold_reason("Opaque", "server.key", &[0x30, 0x82]).is_some());
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

    /// A ConfigMap is not a Secret, but people paste keys into them, and its
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
}
