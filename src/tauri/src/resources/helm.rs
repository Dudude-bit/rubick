//! What a Helm release carries, judged by the rule that withholds a private
//! key.
//!
//! A release keeps the values it was installed with, the manifest its chart
//! rendered and the chart's notes. None of them is an object the API server
//! hands over, so none passes `redact_private_keys` on its way out: this is
//! that rule for each of them, with the same nets.

use std::fmt::Write as _;
use std::io::Read as _;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::tls::{
    is_private_key_text, redact_private_keys, still_withheld, KEY_MAPS, WITHHELD_MARKER,
};

/// What of a release was withheld, and where. The frontend words it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseWithheld {
    /// Where in the values, as `tls.key` or `servers[0].key`.
    pub values: Vec<String>,
    pub manifest: Vec<WithheldDocument>,
    pub notes: bool,
}

/// One document of a release's manifest with something withheld in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithheldDocument {
    /// Its place among the manifest's documents, from one.
    pub position: usize,
    /// The template it was rendered from: its `# Source:` line.
    pub source: Option<String>,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub what: WithheldPart,
}

/// How much of a document was withheld.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum WithheldPart {
    /// These keys' values; every other line is as the chart rendered it.
    Keys { keys: Vec<String> },
    /// These keys' values, in a document written out again to leave them
    /// out: its layout is no longer the chart's.
    Rewritten { keys: Vec<String> },
    /// The document whole. It did not read as YAML, so nothing says it
    /// holds no key.
    Unread,
}

/// Every string in `value`, with where it stands.
fn strings(value: &mut Value, path: &mut String, visit: &mut impl FnMut(&str, &mut String)) {
    let here = path.len();
    match value {
        Value::String(text) => visit(path, text),
        Value::Array(items) => {
            for (at, item) in items.iter_mut().enumerate() {
                let _ = write!(path, "[{at}]");
                strings(item, path, visit);
                path.truncate(here);
            }
        }
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if here > 0 {
                    path.push('.');
                }
                path.push_str(key);
                strings(item, path, visit);
                path.truncate(here);
            }
        }
        _ => {}
    }
}

/// Blank every string of a tree that is a private key, and say where each
/// stood. For values, and for a document that is no Kubernetes object: no
/// key name means anything there, so what the string is is the only net.
pub fn withhold_strings(value: &mut Value) -> Vec<String> {
    let mut blanked = Vec::new();
    strings(value, &mut String::new(), &mut |path, text| {
        if is_private_key_text(text) {
            *text = WITHHELD_MARKER.to_string();
            blanked.push(path.to_string());
        }
    });
    blanked
}

/// Free text as it may leave: whole, or the placeholder where it is a
/// private key. `true` where it was withheld.
pub fn withhold_text(text: &mut String) -> bool {
    let withheld = is_private_key_text(text);
    if withheld {
        *text = WITHHELD_MARKER.to_string();
    }
    withheld
}

/// One document of a manifest, as its text and what the rule found in it.
pub struct ManifestDocument<'a> {
    /// The `---` line and the comments above the first line of content. A
    /// chart's `# Source:` line is here.
    pub head: &'a str,
    pub body: &'a str,
    pub judged: Judged,
}

/// What the rule found in one document.
pub enum Judged {
    /// Comments, or nothing at all.
    Empty,
    /// No private key: the document leaves byte for byte.
    Clean,
    /// It would not read as YAML.
    Unread,
    Keys {
        /// The document with each key blanked.
        shown: Value,
        keys: Vec<String>,
        /// Its own text with only those values replaced, where its lines
        /// said plainly enough which they were.
        in_place: Option<String>,
    },
}

impl ManifestDocument<'_> {
    /// The template the chart rendered this from.
    #[must_use]
    pub fn source(&self) -> Option<String> {
        let lines = self.head.lines();
        let mut named = lines.filter_map(|line| line.trim().strip_prefix("# Source:"));
        named.next().map(|path| path.trim().to_string())
    }
}

/// Whether a line opens a document: `---` alone, or with something after.
fn opens_a_document(line: &str) -> bool {
    let rest = line.strip_prefix("---");
    rest.is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
}

/// The lines before a document's first line of content.
fn head_of(text: &str) -> usize {
    let quiet = |rest: &str| rest.trim().is_empty() || rest.trim_start().starts_with('#');
    let mut len = 0;
    for line in text.split_inclusive('\n') {
        if !(quiet(line) || line.strip_prefix("---").is_some_and(quiet)) {
            break;
        }
        len += line.len();
    }
    len
}

/// A manifest's documents in order, each judged. Their texts, end to end,
/// are the manifest.
#[must_use]
pub fn manifest_documents(manifest: &str) -> Vec<ManifestDocument<'_>> {
    let mut starts = vec![0];
    let mut at = 0;
    for line in manifest.split_inclusive('\n') {
        if at > 0 && opens_a_document(line) {
            starts.push(at);
        }
        at += line.len();
    }
    let ends = starts.iter().skip(1).copied().chain([manifest.len()]);
    starts
        .iter()
        .zip(ends)
        .map(|(start, end)| {
            let text = &manifest[*start..end];
            let (head, body) = text.split_at(head_of(text));
            let judged = if body.is_empty() {
                Judged::Empty
            } else {
                judge(text)
            };
            ManifestDocument { head, body, judged }
        })
        .collect()
}

fn judge(text: &str) -> Judged {
    // Into JSON and not `serde_yaml::Value`, which refuses a mapping that
    // names a key twice. Charts render those, and the API server takes them.
    let Ok(mut shown) = serde_yaml::from_str::<Value>(text) else {
        return Judged::Unread;
    };
    let keys = withhold_in_document(&mut shown);
    if keys.is_empty() {
        return Judged::Clean;
    }
    let edited = blanked_in_place(text, &still_withheld(&shown));
    let in_place =
        (serde_yaml::from_str::<Value>(&edited).ok().as_ref() == Some(&shown)).then_some(edited);
    Judged::Keys {
        shown,
        keys,
        in_place,
    }
}

/// A Kubernetes object is judged as its YAML tab judges it, by
/// [`redact_private_keys`], and a `List` by each of its items. Anything else
/// has no map whose names mean something, and is judged string by string.
fn withhold_in_document(document: &mut Value) -> Vec<String> {
    let names = |field: &str| document.get(field).is_some_and(Value::is_string);
    if !(names("apiVersion") && names("kind")) {
        return withhold_strings(document);
    }
    let mut keys = redact_private_keys(document);
    let items = document.get_mut("items").and_then(Value::as_array_mut);
    for item in items.into_iter().flatten() {
        keys.extend(withhold_in_document(item));
    }
    keys
}

/// The key a line of a block mapping opens with: as written, and as named.
fn key_of(line: &str) -> Option<(&str, &str)> {
    let quote = line.chars().next().filter(|c| matches!(c, '"' | '\''));
    let (written, name) = if let Some(quote) = quote {
        let end = 1 + line[1..].find(quote)?;
        (&line[..=end], &line[1..end])
    } else {
        let last = line.ends_with(':').then(|| line.len() - 1);
        let end = line.find(": ").or(last)?;
        let written = line[..end].trim_end();
        (written, written)
    };
    let rest = line[written.len()..].trim_start().strip_prefix(':')?;
    (rest.is_empty() || rest.starts_with(' ')).then_some((written, name))
}

/// `text` with the value under each of `keys` replaced by the placeholder,
/// for the layout charts write: a key map opened at the left margin, a key
/// to a line, its value on that line or indented under it. Its caller reads
/// the result back and keeps it only where it is the document it meant.
fn blanked_in_place(text: &str, keys: &[String]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_map = false;
    let mut key_indent = None;
    let mut blanking = None;
    for line in text.split_inclusive('\n') {
        let said = line.trim_end();
        let indent = said.len() - said.trim_start().len();
        if let Some(under) = blanking {
            if said.is_empty() || indent > under {
                continue;
            }
            blanking = None;
        }
        if said.is_empty() || said.trim_start().starts_with('#') {
            out.push_str(line);
            continue;
        }
        if indent == 0 {
            let opened = key_of(said).filter(|(written, _)| said[written.len()..].len() == 1);
            in_map = opened.is_some_and(|(_, name)| KEY_MAPS.iter().any(|(map, _)| *map == name));
            key_indent = None;
        } else if in_map && *key_indent.get_or_insert(indent) == indent {
            let key = key_of(&said[indent..]).filter(|(_, name)| keys.iter().any(|k| k == name));
            if let Some((written, _)) = key {
                let _ = write!(out, "{}{written}: '{WITHHELD_MARKER}'", &said[..indent]);
                out.push_str(&line[said.len()..]);
                blanking = Some(indent);
                continue;
            }
        }
        out.push_str(line);
    }
    out
}

/// The JSON of the release a Helm Secret stores under `release`: base64,
/// and gzip under it since Helm 3.
///
/// # Errors
///
/// In the decoder's own words, where the bytes are neither.
pub fn stored_release_json(stored: &[u8]) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let packed = base64::engine::general_purpose::STANDARD
        .decode(stored)
        .map_err(|e| format!("base64: {e}"))?;
    if !packed.starts_with(&[0x1f, 0x8b]) {
        return Ok(packed);
    }
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(&packed[..])
        .read_to_end(&mut json)
        .map_err(|e| format!("gzip: {e}"))?;
    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY_PEM: &str = include_str!("../../tests/fixtures/leaf.key.pem");
    const LEAF_PEM: &str = include_str!("../../tests/fixtures/leaf.crt.pem");

    fn encoded(text: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    /// The string as a chart's `| quote` renders it: one line, escaped.
    fn quoted(text: &str) -> String {
        serde_json::to_string(text).expect("a string")
    }

    /// The string as a block scalar under a key indented by two.
    fn block(text: &str) -> String {
        let lines: Vec<String> = text.lines().map(|line| format!("    {line}")).collect();
        format!("|\n{}", lines.join("\n"))
    }

    /// The one document of `text`: as it leaves with its own lines kept,
    /// and the keys blanked in it.
    fn kept(text: &str) -> (String, Vec<String>) {
        let mut documents = manifest_documents(text);
        assert_eq!(documents.len(), 1, "{text}");
        match documents.remove(0).judged {
            Judged::Keys {
                keys,
                in_place: Some(text),
                ..
            } => (text, keys),
            _ => panic!("not blanked in place: {text}"),
        }
    }

    /// `helm install --set privateKey=…` put the key on the Values tab in
    /// full. A values tree has no key map: fails if the key is missed four
    /// maps down under a name that says nothing, in a list, or as base64,
    /// wrapped the way `base64` prints it or not.
    #[test]
    fn a_private_key_in_the_values_is_withheld_at_any_depth_under_any_name() {
        let wrapped: Vec<String> = encoded(KEY_PEM)
            .as_bytes()
            .chunks(76)
            .map(|line| String::from_utf8_lossy(line).into_owned())
            .collect();
        let mut values = json!({
            "ingress": { "tls": { "material": { "blob": KEY_PEM, "cert": LEAF_PEM } } },
            "password": "hunter2",
            "replicaCount": 2,
            "servers": [{ "host": "a" }, { "host": "b", "identity": encoded(KEY_PEM) }],
            "wrapped": wrapped.join("\n"),
        });

        let blanked = withhold_strings(&mut values);

        assert_eq!(
            blanked,
            [
                "ingress.tls.material.blob",
                "servers[1].identity",
                "wrapped"
            ]
        );
        assert_eq!(
            values["ingress"]["tls"]["material"]["blob"],
            WITHHELD_MARKER
        );
        assert_eq!(values["servers"][1]["identity"], WITHHELD_MARKER);
        assert_eq!(values["wrapped"], WITHHELD_MARKER);
        let left = values.to_string();
        assert!(!left.contains("PRIVATE KEY") && !left.contains(&encoded(KEY_PEM)[..64]));
    }

    /// Would blank values the rule has no business in: a certificate, a
    /// password, base64 of something else, a string that names a key.
    #[test]
    fn values_with_no_private_key_in_them_are_left_as_they_were() {
        let mut values = json!({
            "tls": { "crt": LEAF_PEM, "crtB64": encoded(LEAF_PEM) },
            "password": "hunter2",
            "keyFile": "/etc/tls/tls.key",
            "note": "paste the PRIVATE KEY here",
            "ports": [80, 443],
        });
        let before = values.clone();

        assert!(withhold_strings(&mut values).is_empty());
        assert_eq!(values, before);
    }

    /// The Secret of the reported chart, `stringData` rendered with
    /// `| quote`. Fails if the key is on the Manifest tab, or if any line
    /// but the key's own is not the chart's to the byte.
    #[test]
    fn a_secret_rendered_with_stringdata_keeps_every_line_but_the_keys() {
        let rendered = |key: &str| {
            format!(
                "---\n# Source: keys/templates/secret.yaml\napiVersion: v1\nkind: Secret\n\
                 metadata: {{name: web-key}}\nstringData:\n  tls.key: {key}\n  \
                 password: \"hunter2\"   # kept\n"
            )
        };

        let (text, keys) = kept(&rendered(&quoted(KEY_PEM)));
        assert_eq!(keys, ["tls.key"]);
        assert_eq!(text, rendered(&format!("'{WITHHELD_MARKER}'")));

        // The same key as a block scalar, under a name that says nothing.
        let noted = |key: &str| rendered(key).replace("tls.key", "note");
        let (text, keys) = kept(&noted(&block(KEY_PEM)));
        assert_eq!(keys, ["note"]);
        assert_eq!(text, noted(&format!("'{WITHHELD_MARKER}'")));
    }

    /// `data` is base64, one `base64 -d` from the key. Fails if the key is
    /// handed over encoded, or the certificate beside it is not.
    #[test]
    fn a_secret_rendered_with_base64_data_keeps_the_certificate_and_not_the_key() {
        let rendered = |key: &str| {
            format!(
                "# Source: web/templates/tls.yaml\napiVersion: v1\nkind: Secret\n\
                 type: kubernetes.io/tls\nmetadata:\n  name: web-tls\ndata:\n  \
                 tls.crt: {}\n  \"tls.key\": {key}\n",
                encoded(LEAF_PEM)
            )
        };

        let (text, keys) = kept(&rendered(&encoded(KEY_PEM)));

        assert_eq!(keys, ["tls.key"]);
        assert_eq!(text, rendered(&format!("'{WITHHELD_MARKER}'")));
    }

    /// A `ConfigMap` is where a key gets pasted. Fails if the key under
    /// `data` or `binaryData` is handed over, or the config beside it is not.
    #[test]
    fn a_configmap_keeps_its_config_and_not_the_key_pasted_beside_it() {
        let rendered = |key: &str, bundle: &str| {
            format!(
                "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: nginx\ndata:\n  \
                 nginx.conf: |\n    worker_processes 2;\n\n    events {{}}\n  \
                 server.key: {key}\nbinaryData:\n  bundle.p12: {bundle}\n"
            )
        };
        let marker = format!("'{WITHHELD_MARKER}'");

        let (text, mut keys) = kept(&rendered(&block(KEY_PEM), &encoded(KEY_PEM)));

        keys.sort();
        assert_eq!(keys, ["bundle.p12", "server.key"]);
        assert_eq!(text, rendered(&marker, &marker));
    }

    /// Charts render a mapping that names a key twice, and the API server
    /// takes it. A parser that refuses those left the Secret unjudged.
    #[test]
    fn a_document_that_names_a_key_twice_is_still_judged() {
        let rendered = |key: &str| {
            format!(
                "apiVersion: v1\nkind: Secret\nmetadata:\n  name: twice\n  labels:\n    \
                 app: web\n    app: web\ndata:\n  id_rsa: {key}\n"
            )
        };

        let (text, keys) = kept(&rendered(&encoded(KEY_PEM)));

        assert_eq!(keys, ["id_rsa"]);
        assert_eq!(text, rendered(&format!("'{WITHHELD_MARKER}'")));
    }

    /// A document with no `kind` is no object, and has no map whose names
    /// the rule knows: judged like values, by what each string is.
    #[test]
    fn a_document_that_is_no_kubernetes_object_is_judged_string_by_string() {
        let text = format!(
            "# Source: web/templates/settings.yaml\nsettings:\n  signing:\n    material: {}\n  \
             level: debug\n",
            quoted(KEY_PEM)
        );

        let mut documents = manifest_documents(&text);
        let Judged::Keys { shown, keys, .. } = documents.remove(0).judged else {
            panic!("the key was not found");
        };

        assert_eq!(keys, ["settings.signing.material"]);
        assert_eq!(shown["settings"]["signing"]["material"], WITHHELD_MARKER);
        assert_eq!(shown["settings"]["level"], "debug");
    }

    /// `kubectl get -o yaml` writes a `List`, and helm applies one: its
    /// Secrets are objects like any other.
    #[test]
    fn a_list_is_judged_item_by_item() {
        let text = format!(
            "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  \
             metadata:\n    name: deploy\n  data:\n    id_rsa: {}\n    user: Z2l0\n",
            encoded(KEY_PEM)
        );

        let mut documents = manifest_documents(&text);
        let Judged::Keys { shown, keys, .. } = documents.remove(0).judged else {
            panic!("the key was not found");
        };

        assert_eq!(keys, ["id_rsa"]);
        assert_eq!(shown["items"][0]["data"]["id_rsa"], WITHHELD_MARKER);
        assert_eq!(shown["items"][0]["data"]["user"], "Z2l0");
    }

    /// Text edited in place is offered only where it reads back as the
    /// document meant: a flow map names the key on a line the edit does not
    /// know, and left as it was that line is the key. And a line of prose
    /// that looks like the key's, inside another value, is not blanked.
    #[test]
    fn a_layout_the_lines_do_not_say_plainly_is_not_edited_in_place() {
        let flow = format!(
            "apiVersion: v1\nkind: Secret\nmetadata:\n  name: flow\ndata: {{\"tls.key\": \"{}\"}}\n",
            encoded(KEY_PEM)
        );
        let mut documents = manifest_documents(&flow);
        let Judged::Keys { keys, in_place, .. } = documents.remove(0).judged else {
            panic!("the key was not found");
        };
        assert_eq!(keys, ["tls.key"]);
        assert_eq!(in_place, None);

        let nested = format!(
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: nested\ndata:\n  \
             readme: |\n    server.key: stays, it is prose\n  server.key: {}\n",
            block(KEY_PEM)
        );
        let (text, _) = kept(&nested);
        assert!(
            text.contains("    server.key: stays, it is prose\n"),
            "{text}"
        );
        assert!(!text.contains("PRIVATE KEY"), "{text}");
    }

    /// A chart's notes are prose, and prose with a key in it is withheld
    /// whole, as a `ConfigMap` value with a key in it is.
    #[test]
    fn notes_that_print_a_private_key_are_withheld_and_others_are_not() {
        let mut notes = format!("Your key:\n\n{KEY_PEM}\nKeep it safe.\n");
        assert!(withhold_text(&mut notes));
        assert_eq!(notes, WITHHELD_MARKER);

        let mut plain = "1. Get the URL:\n  kubectl get svc web\n".to_string();
        assert!(!withhold_text(&mut plain));
        assert_eq!(plain, "1. Get the URL:\n  kubectl get svc web\n");
    }
}
