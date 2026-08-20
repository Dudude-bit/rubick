//! YAML manifest parsing — splits multi-document YAML, lifts every
//! document into a `kube::core::DynamicObject` paired with the
//! `ApiResource` needed to address its dynamic API. The kube
//! `pluralize` impl + the `is_cluster_scoped` discriminator live
//! here too since both are pure-data helpers consumed only by this
//! module's parser.

use crate::error::{Error, Result};
use kube::core::DynamicObject;
use kube::discovery::ApiResource;

/// Parsed manifest with API resource info
pub(super) struct ParsedManifest {
    pub api_resource: ApiResource,
    pub object: DynamicObject,
    pub namespace: Option<String>,
}

impl ParsedManifest {
    /// Get the effective namespace (from manifest, fallback, or "default")
    pub fn effective_namespace(&self, fallback: &Option<String>) -> String {
        self.namespace
            .clone()
            .or_else(|| fallback.clone())
            .unwrap_or_else(|| "default".to_string())
    }

    /// Get the resource name or "<unnamed>"
    pub fn name(&self) -> String {
        self.object
            .metadata
            .name
            .clone()
            .unwrap_or_else(|| "<unnamed>".to_string())
    }

    /// Format resource identifier for messages (e.g., "deployment/default nginx")
    pub fn format_id(&self, namespace: &str, action: &str) -> String {
        format!(
            "{}/{} {} {}",
            self.api_resource.kind.to_lowercase(),
            namespace,
            self.name(),
            action
        )
    }
}

/// Parse all documents from a manifest string
pub(super) fn parse_all_documents(manifest: &str) -> Result<Vec<ParsedManifest>> {
    let documents = split_yaml_documents(manifest);

    if documents.is_empty() {
        return Err(Error::InvalidInput(
            "No valid YAML documents found".to_string(),
        ));
    }

    documents
        .iter()
        .enumerate()
        .map(|(i, doc)| {
            parse_manifest_document(doc)
                .map_err(|e| Error::InvalidInput(format!("Document {}: {}", i + 1, e)))
        })
        .collect()
}

/// Parse a single YAML document into a `DynamicObject` with API resource info
fn parse_manifest_document(yaml_doc: &str) -> Result<ParsedManifest> {
    // Parse YAML to get apiVersion and kind
    let value: serde_yaml::Value =
        serde_yaml::from_str(yaml_doc).map_err(|e| Error::Serialization(e.to_string()))?;

    let api_version = value
        .get("apiVersion")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::InvalidInput("Missing apiVersion in manifest".to_string()))?;

    let kind = value
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::InvalidInput("Missing kind in manifest".to_string()))?;

    let metadata = value
        .get("metadata")
        .ok_or_else(|| Error::InvalidInput("Missing metadata in manifest".to_string()))?;

    let name = metadata
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::InvalidInput("Missing metadata.name in manifest".to_string()))?;

    let namespace = metadata.get("namespace").and_then(|v| v.as_str());

    // Parse group and version from apiVersion
    let (group, version) = parse_api_version(api_version);

    // Create ApiResource
    let api_resource = ApiResource {
        group,
        version,
        kind: kind.to_string(),
        api_version: api_version.to_string(),
        plural: pluralize(kind),
    };

    // Parse as DynamicObject
    let mut object: DynamicObject =
        serde_yaml::from_str(yaml_doc).map_err(|e| Error::Serialization(e.to_string()))?;

    // Ensure metadata is set
    if object.metadata.name.is_none() {
        object.metadata.name = Some(name.to_string());
    }

    Ok(ParsedManifest {
        api_resource,
        object,
        namespace: namespace.map(String::from),
    })
}

/// Build an `ApiResource` directly from kind + apiVersion + name. Used by
/// `get_manifest` which doesn't have a YAML body to parse.
pub(super) fn api_resource_for(kind: &str, api_version: &str) -> ApiResource {
    let (group, version) = parse_api_version(api_version);
    ApiResource {
        group,
        version,
        kind: kind.to_string(),
        api_version: api_version.to_string(),
        plural: pluralize(kind),
    }
}

fn parse_api_version(api_version: &str) -> (String, String) {
    if api_version.contains('/') {
        let parts: Vec<&str> = api_version.splitn(2, '/').collect();
        (parts[0].to_string(), parts[1].to_string())
    } else {
        // Core API (v1)
        (String::new(), api_version.to_string())
    }
}

/// Simple pluralization for Kubernetes resource kinds
pub(super) fn pluralize(kind: &str) -> String {
    let lower = kind.to_lowercase();

    // Special cases
    match lower.as_str() {
        "endpoints" => "endpoints".to_string(),
        "ingress" => "ingresses".to_string(),
        "networkpolicy" => "networkpolicies".to_string(),
        "podsecuritypolicy" => "podsecuritypolicies".to_string(),
        "storageclass" => "storageclasses".to_string(),
        "ingressclass" => "ingressclasses".to_string(),
        "runtimeclass" => "runtimeclasses".to_string(),
        "priorityclass" => "priorityclasses".to_string(),
        _ => {
            // Standard pluralization rules
            if lower.ends_with('s') || lower.ends_with('x') || lower.ends_with("ch") {
                format!("{lower}es")
            } else if lower.ends_with('y') {
                format!("{}ies", &lower[..lower.len() - 1])
            } else {
                format!("{lower}s")
            }
        }
    }
}

/// Split YAML into multiple documents
fn split_yaml_documents(manifest: &str) -> Vec<String> {
    manifest
        .split("\n---")
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with('#'))
        .map(String::from)
        .collect()
}

/// Check if a kind is cluster-scoped (not namespaced)
pub(super) fn is_cluster_scoped(kind: &str) -> bool {
    matches!(
        kind,
        "Namespace"
            | "Node"
            | "PersistentVolume"
            | "ClusterRole"
            | "ClusterRoleBinding"
            | "StorageClass"
            | "PriorityClass"
            | "IngressClass"
            | "RuntimeClass"
            | "CustomResourceDefinition"
            | "APIService"
            | "MutatingWebhookConfiguration"
            | "ValidatingWebhookConfiguration"
            | "PodSecurityPolicy"
            | "CertificateSigningRequest"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pluralize() {
        assert_eq!(pluralize("Pod"), "pods");
        assert_eq!(pluralize("Deployment"), "deployments");
        assert_eq!(pluralize("Service"), "services");
        assert_eq!(pluralize("Ingress"), "ingresses");
        assert_eq!(pluralize("NetworkPolicy"), "networkpolicies");
        assert_eq!(pluralize("StorageClass"), "storageclasses");
    }

    #[test]
    fn test_split_yaml_documents() {
        let yaml = r"
apiVersion: v1
kind: ConfigMap
metadata:
    name: test1
---
apiVersion: v1
kind: ConfigMap
metadata:
    name: test2
";
        let docs = split_yaml_documents(yaml);
        assert_eq!(docs.len(), 2);
    }

    #[test]
    fn test_parse_manifest_document() {
        let yaml = r"
apiVersion: v1
kind: ConfigMap
metadata:
    name: test-config
    namespace: default
data:
    key: value
";
        let parsed = parse_manifest_document(yaml).unwrap();
        assert_eq!(parsed.api_resource.kind, "ConfigMap");
        assert_eq!(parsed.api_resource.version, "v1");
        assert_eq!(parsed.namespace, Some("default".to_string()));
    }

    #[test]
    fn test_parse_apps_api() {
        let yaml = r"
apiVersion: apps/v1
kind: Deployment
metadata:
    name: test-deploy
";
        let parsed = parse_manifest_document(yaml).unwrap();
        assert_eq!(parsed.api_resource.kind, "Deployment");
        assert_eq!(parsed.api_resource.group, "apps");
        assert_eq!(parsed.api_resource.version, "v1");
    }
}
