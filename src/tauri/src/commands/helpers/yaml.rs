//! Cleans a resource's YAML for the editor by stripping the metadata the
//! server owns, so what the editor shows is what you could re-apply.

use crate::error::{Error, Result};
use crate::resources::{
    manifest_documents, Judged, WithheldDocument, WithheldPart, WITHHELD_MARKER,
};

/// The YAML the editor shows for an object: private keys withheld, server
/// bookkeeping stripped. Every manifest that leaves for the screen is made
/// here, so each is cleaned alike and a Secret stays a Secret.
pub fn editor_yaml<T: serde::Serialize>(object: &T) -> Result<String> {
    let value = crate::resources::shown(object).map_err(|e| Error::Serialization(e.to_string()))?;
    let yaml = serde_yaml::to_string(&value).map_err(|e| Error::Serialization(e.to_string()))?;
    clean_yaml_for_editor(&yaml)
}

/// A Helm release's manifest as it may leave for the screen, and what was
/// withheld in which document. A document with no key in it is the chart's
/// to the byte, and one with a key keeps its `# Source:` line.
#[must_use]
pub fn shown_manifest(manifest: &str) -> (String, Vec<WithheldDocument>) {
    let mut text = String::with_capacity(manifest.len());
    let mut withheld = Vec::new();
    let mut position = 0;
    for document in manifest_documents(manifest) {
        position += usize::from(!matches!(document.judged, Judged::Empty));
        let (written, object, what) = match &document.judged {
            Judged::Empty | Judged::Clean => {
                text.extend([document.head, document.body]);
                continue;
            }
            Judged::Unread => (None, None, WithheldPart::Unread),
            Judged::Keys {
                shown,
                keys,
                in_place,
            } => {
                let keys = keys.clone();
                let what = match in_place {
                    Some(_) => WithheldPart::Keys { keys },
                    None => WithheldPart::Rewritten { keys },
                };
                (in_place.clone(), Some(shown), what)
            }
        };
        let named = |at: &str| object?.pointer(at)?.as_str().map(str::to_string);
        withheld.push(WithheldDocument {
            position,
            source: document.source(),
            kind: named("/kind"),
            name: named("/metadata/name"),
            what,
        });
        if let Some(written) = written {
            text.push_str(&written);
            continue;
        }
        let body = object.and_then(|shown| serde_yaml::to_string(shown).ok());
        let body = body.unwrap_or_else(|| format!("'{WITHHELD_MARKER}'\n"));
        let opens = if document.body.starts_with("---") {
            "---\n"
        } else {
            ""
        };
        text.extend([document.head, opens, &body]);
    }
    (text, withheld)
}

/// Clean YAML for editor (remove unwanted fields, format)
fn clean_yaml_for_editor(yaml: &str) -> Result<String> {
    let mut value: serde_yaml::Value = serde_yaml::from_str(yaml)
        .map_err(|e| Error::Serialization(format!("Failed to parse YAML: {e}")))?;

    if let Some(mapping) = value.as_mapping_mut() {
        mapping.remove("status");

        // Remove server-managed metadata fields
        if let Some(metadata) = mapping.get_mut("metadata") {
            if let Some(meta_map) = metadata.as_mapping_mut() {
                for field in [
                    "resourceVersion",
                    "uid",
                    "generation",
                    "creationTimestamp",
                    "selfLink",
                    "managedFields",
                    "ownerReferences",
                    "finalizers",
                    "deletionTimestamp",
                    "deletionGracePeriodSeconds",
                ] {
                    meta_map.remove(field);
                }
            }
        }
    }

    serde_yaml::to_string(&value)
        .map_err(|e| Error::Serialization(format!("Failed to serialize YAML: {e}")))
}

#[cfg(test)]
mod tests {
    use super::{editor_yaml, shown_manifest, WithheldDocument, WithheldPart, WITHHELD_MARKER};
    use serde::Deserialize as _;

    const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");

    fn encoded(text: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    /// Every document of a manifest, read back the way `kubectl` would.
    fn read_back(manifest: &str) -> Vec<serde_json::Value> {
        serde_yaml::Deserializer::from_str(manifest)
            .map(|document| serde_json::Value::deserialize(document).expect("valid YAML"))
            .collect()
    }

    const DEPLOYMENT: &str = "---\n# Source: web/templates/deployment.yaml\n# two replicas, on purpose\n\
        apiVersion: apps/v1\nkind:   Deployment   \nmetadata: {name: web, labels: {app: web, app: web}}\n\
        spec:\n  replicas: 2 # not three\n  template:\n    spec:\n      containers:\n      \
        - name: web\n        env:\n        - {name: KEY_FILE, value: \"/etc/tls/tls.key\"}\n";
    const SERVICE: &str =
        "---\n# Source: web/templates/service.yaml\napiVersion: v1\nkind: Service\n\
        metadata:\n  name: web\nspec:\n  ports:\n  - port: 80\n";

    fn secret(key: &str) -> String {
        format!(
            "---\n# Source: web/templates/key.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  \
             name: web-key\nstringData:\n  tls.key: {key}\n  password: \"hunter2\"\n"
        )
    }

    /// The Manifest tab of a release drew `tls.key` in full, with Copy. Fails
    /// if the key leaves, if the document it was in is not named, or if any
    /// byte of the documents around it, comments and spacing, is not the
    /// chart's.
    #[test]
    fn a_release_manifest_leaves_without_the_key_and_says_which_document_held_it() {
        let quoted = serde_json::to_string(KEY).expect("a string");
        let manifest = [DEPLOYMENT, &secret(&quoted), SERVICE].concat();

        let (shown, withheld) = shown_manifest(&manifest);

        let marker = format!("'{WITHHELD_MARKER}'");
        assert_eq!(shown, [DEPLOYMENT, &secret(&marker), SERVICE].concat());
        assert_eq!(
            withheld,
            [WithheldDocument {
                position: 2,
                source: Some("web/templates/key.yaml".to_string()),
                kind: Some("Secret".to_string()),
                name: Some("web-key".to_string()),
                what: WithheldPart::Keys {
                    keys: vec!["tls.key".to_string()]
                },
            }]
        );
    }

    /// A manifest with no key in it is the chart's to the byte: its comments,
    /// its spacing, a key named twice, a document of comments, a trailing
    /// separator, and no newline at its end.
    #[test]
    fn a_manifest_with_no_key_in_it_leaves_byte_for_byte() {
        let certificate = include_str!("../../../tests/fixtures/leaf.crt.pem");
        let manifest = format!(
            "# rendered by helm\n{DEPLOYMENT}---\n# Source: web/templates/empty.yaml\n\
             # nothing rendered\n{SERVICE}--- # the certificate\napiVersion: v1\nkind: Secret\n\
             metadata:\n  name: ca\ndata:\n  ca.crt: {}\r\n---\nlast: line",
            encoded(certificate)
        );

        let (shown, withheld) = shown_manifest(&manifest);

        assert_eq!(shown, manifest);
        assert_eq!(withheld, []);
    }

    /// Where a document's lines do not say plainly which hold the key, it is
    /// written out again: still YAML, still under its `# Source:` line, every
    /// other value as it was, and said to be rewritten.
    #[test]
    fn a_document_that_cannot_be_edited_in_place_is_written_again_without_the_key() {
        let flow = format!(
            "---\n# Source: web/templates/flow.yaml\napiVersion: v1\nkind: Secret\n\
             metadata: {{name: flow}}\ndata: {{\"user\": \"Z2l0\", \"id_rsa\": \"{}\"}}\n",
            encoded(KEY)
        );
        let settings = format!(
            "--- # no kind: not an object\nsettings:\n  signing:\n    material: {}\n  level: debug\n",
            serde_json::to_string(KEY).expect("a string")
        );
        let manifest = [DEPLOYMENT, &flow, &settings, SERVICE].concat();

        let (shown, withheld) = shown_manifest(&manifest);

        assert!(!shown.contains("PRIVATE KEY") && !shown.contains(&encoded(KEY)[..64]));
        assert!(shown.starts_with(DEPLOYMENT) && shown.ends_with(SERVICE));
        assert!(shown.contains("---\n# Source: web/templates/flow.yaml\n"));
        let documents = read_back(&shown);
        assert_eq!(documents.len(), 4, "{shown}");
        assert_eq!(documents[1]["metadata"]["name"], "flow");
        assert_eq!(documents[1]["data"]["user"], "Z2l0");
        assert_eq!(documents[1]["data"]["id_rsa"], WITHHELD_MARKER);
        assert_eq!(
            documents[2]["settings"],
            serde_json::json!({ "signing": { "material": WITHHELD_MARKER }, "level": "debug" })
        );
        let rewritten = |keys: &[&str]| WithheldPart::Rewritten {
            keys: keys.iter().map(ToString::to_string).collect(),
        };
        let said: Vec<_> = withheld
            .iter()
            .map(|document| (document.position, document.kind.as_deref(), &document.what))
            .collect();
        assert_eq!(
            said,
            [
                (2, Some("Secret"), &rewritten(&["id_rsa"])),
                (3, None, &rewritten(&["settings.signing.material"])),
            ]
        );
    }

    /// A document that will not read as YAML cannot be said to hold no key.
    /// Passed through, it was a key in clear whenever the parser gave up
    /// first: it leaves as the placeholder under its `# Source:` line, the
    /// manifest still reads as YAML, and the reader is told it was not read.
    #[test]
    fn a_document_that_will_not_read_is_withheld_whole_and_said_to_be_unread() {
        let broken = format!(
            "---\n# Source: web/templates/broken.yaml\nkind: Secret\nstringData: [\n  tls.key: |\n{KEY}"
        );
        let manifest = [DEPLOYMENT, &broken, SERVICE].concat();

        let (shown, withheld) = shown_manifest(&manifest);

        let placeholder =
            format!("---\n# Source: web/templates/broken.yaml\n'{WITHHELD_MARKER}'\n");
        assert_eq!(shown, [DEPLOYMENT, &placeholder, SERVICE].concat());
        assert_eq!(read_back(&shown)[1], WITHHELD_MARKER);
        assert_eq!(
            withheld,
            [WithheldDocument {
                position: 2,
                source: Some("web/templates/broken.yaml".to_string()),
                kind: None,
                name: None,
                what: WithheldPart::Unread,
            }]
        );
    }
    const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

    fn annotation(yaml: &str) -> String {
        let parsed: serde_yaml::Value = serde_yaml::from_str(yaml).expect("YAML");
        parsed["metadata"]["annotations"][LAST_APPLIED]
            .as_str()
            .expect("the annotation")
            .to_string()
    }

    /// Every YAML tab, the editor's buffer and both sides of the dry run are
    /// this text. Fails if the key is in it, under `data` or in the record
    /// `kubectl apply` keeps, or if the record stops being JSON.
    #[test]
    fn the_yaml_of_an_applied_configmap_carries_the_key_nowhere() {
        let applied = serde_json::json!({ "kind": "ConfigMap", "data": { "server.key": KEY } });
        let yaml = editor_yaml(&serde_json::json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {
                "name": "nginx",
                "uid": "4afe41e6",
                "annotations": { LAST_APPLIED: format!("{applied}\n") },
            },
            "data": { "nginx.conf": "worker_processes 2;", "server.key": KEY },
        }))
        .expect("YAML");

        assert!(!yaml.contains("PRIVATE KEY"), "{yaml}");
        assert!(yaml.contains("nginx.conf: worker_processes 2;"), "{yaml}");
        assert!(!yaml.contains("4afe41e6"), "server bookkeeping: {yaml}");
        let record: serde_json::Value = serde_json::from_str(&annotation(&yaml)).expect("JSON");
        assert_eq!(
            record["data"]["server.key"],
            crate::resources::WITHHELD_MARKER
        );
    }

    /// A record with no key in it is kubectl's, to the byte: rewritten, the
    /// editor would send back an annotation the reader never touched.
    #[test]
    fn the_yaml_of_an_object_with_no_key_keeps_the_record_as_written() {
        let record = "{\"kind\":\"Deployment\", \"spec\":{\"replicas\":2}}\n";
        let yaml = editor_yaml(&serde_json::json!({
            "kind": "Deployment",
            "metadata": { "name": "web", "annotations": { LAST_APPLIED: record } },
            "spec": { "replicas": 2 },
        }))
        .expect("YAML");
        assert_eq!(annotation(&yaml), record);
    }
}
