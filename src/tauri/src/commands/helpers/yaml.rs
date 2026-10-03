//! Cleans a resource's YAML for the editor by stripping the metadata the
//! server owns, so what the editor shows is what you could re-apply.

use crate::error::{Error, Result};

/// Clean YAML for editor (remove unwanted fields, format)
pub fn clean_yaml_for_editor(yaml: &str) -> Result<String> {
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
