//! Cleans a resource's YAML for the editor by stripping the metadata the
//! server owns, so what the editor shows is what you could re-apply.

use crate::error::{Error, Result};

/// The YAML the editor shows for an object: private keys withheld, server
/// bookkeeping stripped. Every manifest that leaves for the screen is made
/// here, so each is cleaned alike and a Secret stays a Secret.
pub fn editor_yaml<T: serde::Serialize>(object: &T) -> Result<String> {
    let value = crate::resources::shown(object).map_err(|e| Error::Serialization(e.to_string()))?;
    let yaml = serde_yaml::to_string(&value).map_err(|e| Error::Serialization(e.to_string()))?;
    clean_yaml_for_editor(&yaml)
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
    use super::editor_yaml;

    const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");
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
