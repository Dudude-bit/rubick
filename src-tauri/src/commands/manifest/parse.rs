//! YAML manifest parsing — splits multi-document YAML, lifts every
//! document into a `kube::core::DynamicObject` paired with the
//! `ApiResource` needed to address its dynamic API. The kube
//! `pluralize` impl + the `is_cluster_scoped` discriminator live
//! here too since both are pure-data helpers consumed only by this
//! module's parser.

use crate::error::{Error, Result};
use kube::core::DynamicObject;
use kube::discovery::ApiResource;
use serde::Deserialize as _;

/// Parsed manifest with API resource info
pub(super) struct ParsedManifest {
    pub api_resource: ApiResource,
    pub object: DynamicObject,
    pub namespace: Option<String>,
}

impl ParsedManifest {
    /// Get the effective namespace (from manifest, fallback, or "default")
    pub fn effective_namespace(&self, fallback: Option<&str>) -> String {
        self.namespace
            .clone()
            .or_else(|| fallback.map(str::to_string))
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
    let documents = yaml_documents(manifest)?;

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
fn parse_manifest_document(value: &serde_yaml::Value) -> Result<ParsedManifest> {
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

    let (group, version) = parse_api_version(api_version);

    let api_resource = ApiResource {
        group,
        version,
        kind: kind.to_string(),
        api_version: api_version.to_string(),
        plural: pluralize(kind),
    };

    let mut object: DynamicObject =
        serde_yaml::from_value(value.clone()).map_err(|e| Error::Serialization(e.to_string()))?;

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
            // Standard pluralization rules. `-y` becomes `-ies` only after
            // a consonant: policy → policies, but gateway → gateways — the
            // "gatewaies" this once produced 404'd every Gateway YAML tab.
            let consonant_y = lower.ends_with('y')
                && !matches!(
                    lower.as_bytes().get(lower.len().wrapping_sub(2)),
                    Some(b'a' | b'e' | b'i' | b'o' | b'u')
                );
            if lower.ends_with('s') || lower.ends_with('x') || lower.ends_with("ch") {
                format!("{lower}es")
            } else if consonant_y {
                format!("{}ies", &lower[..lower.len() - 1])
            } else {
                format!("{lower}s")
            }
        }
    }
}

/// The documents a manifest holds, in order.
///
/// Parsed, not split on a separator. Splitting on `\n---` and dropping any
/// piece that began with `#` threw away every document `helm template`
/// writes — each one opens with a `# Source: …` line — so applying its output
/// sent the cluster the first object, silently discarded the rest, and
/// reported success. A lone comment at the top of a single-document manifest
/// emptied it entirely and answered "No valid YAML documents found".
fn yaml_documents(manifest: &str) -> Result<Vec<serde_yaml::Value>> {
    let mut documents = Vec::new();
    for document in serde_yaml::Deserializer::from_str(manifest) {
        let value = serde_yaml::Value::deserialize(document)
            .map_err(|e| Error::Serialization(e.to_string()))?;
        // A document of nothing but comments — or the empty tail a trailing
        // `---` leaves — reads as null, and null is not an object to apply.
        if !value.is_null() {
            documents.push(value);
        }
    }
    Ok(documents)
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
            | "GatewayClass"
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
    fn gateway_class_is_cluster_scoped() {
        // getManifest built a namespaced path for it and got the
        // apiserver mux's raw 404 - the detail page could not read
        // the YAML of a perfectly real GatewayClass.
        assert!(is_cluster_scoped("GatewayClass"));
        assert!(!is_cluster_scoped("Gateway"));
    }

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
        assert_eq!(yaml_documents(yaml).expect("parses").len(), 2);
    }

    /// Every document `helm template` writes opens with `# Source: …`, and
    /// splitting on the separator dropped all but the first — so applying a
    /// chart sent one object to the cluster and called it a success.
    #[test]
    fn keeps_the_documents_helm_writes() {
        let yaml = r"---
# Source: demo/templates/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: demo
---
# Source: demo/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: demo
---
# Source: demo/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
";
        let documents = yaml_documents(yaml).expect("parses");
        assert_eq!(documents.len(), 3, "helm output lost documents");
        let kinds: Vec<_> = documents
            .iter()
            .filter_map(|doc| doc.get("kind").and_then(serde_yaml::Value::as_str))
            .collect();
        assert_eq!(kinds, ["ServiceAccount", "Service", "Deployment"]);
    }

    /// One document that merely starts with a comment used to leave nothing
    /// at all, and the reader was told their manifest held no YAML.
    #[test]
    fn a_comment_on_the_first_line_is_not_an_empty_manifest() {
        let yaml =
            "# my nginx deployment\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: n\n";
        assert_eq!(yaml_documents(yaml).expect("parses").len(), 1);
    }

    /// A trailing separator leaves an empty tail, which is not an object.
    #[test]
    fn a_trailing_separator_adds_nothing() {
        let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\n";
        assert_eq!(yaml_documents(yaml).expect("parses").len(), 1);
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
        let parsed = parse_manifest_document(&serde_yaml::from_str(yaml).unwrap()).unwrap();
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
        let parsed = parse_manifest_document(&serde_yaml::from_str(yaml).unwrap()).unwrap();
        assert_eq!(parsed.api_resource.kind, "Deployment");
        assert_eq!(parsed.api_resource.group, "apps");
        assert_eq!(parsed.api_resource.version, "v1");
    }

    #[test]
    fn pluralize_keeps_a_vowel_before_the_final_y() {
        // "-ay" is not "-cy": a Gateway lists at /gateways, and the rule
        // that turned it into "gatewaies" 404d every Gateway YAML tab.
        assert_eq!(pluralize("Gateway"), "gateways");
        assert_eq!(pluralize("NetworkPolicy"), "networkpolicies");
        assert_eq!(pluralize("HTTPRoute"), "httproutes");
        assert_eq!(pluralize("TLSRoute"), "tlsroutes");
    }
}
