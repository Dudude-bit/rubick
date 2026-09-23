//! Input validation for Kubernetes resources

use crate::error::{Error, Result};
use crate::utils::{is_valid_dns_label, is_valid_dns_subdomain};

/// The rule Kubernetes holds a `K`'s name to.
///
/// Most kinds take a DNS subdomain, dots and all: a static pod named after a
/// node's FQDN, every node on EKS. Checking those as labels made objects the
/// list showed impossible to open, delete or debug. Only a Namespace and a
/// Service are held to the label.
pub fn validate_name<K>(name: &str) -> Result<()>
where
    K: kube::Resource,
    K::DynamicType: Default,
{
    match K::kind(&K::DynamicType::default()).as_ref() {
        "Namespace" | "Service" => validate_dns_label(name),
        _ => validate_dns_subdomain(name),
    }
}

/// Validate a name as a DNS-1123 label (no dots, max 63 chars): a Namespace,
/// a Service, a container. For an object, [`validate_name`] picks the rule.
pub fn validate_dns_label(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(Error::InvalidInput(
            "Resource name cannot be empty".to_string(),
        ));
    }

    if name.len() > 63 {
        return Err(Error::InvalidInput(format!(
            "Resource name '{name}' exceeds maximum length of 63 characters"
        )));
    }

    if !is_valid_dns_label(name) {
        return Err(Error::InvalidInput(format!(
            "Resource name '{name}' is not a valid DNS-1123 label. Must be lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character (no dots allowed)"
        )));
    }

    Ok(())
}

/// Validate a Kubernetes resource name as DNS-1123 subdomain (dots allowed, max 253 chars)
/// Used for: CRD names, Node names, `ConfigMap`, Secret, PV, PVC, `StorageClass`, Ingress, Helm releases
pub fn validate_dns_subdomain(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(Error::InvalidInput(
            "Resource name cannot be empty".to_string(),
        ));
    }

    if name.len() > 253 {
        return Err(Error::InvalidInput(format!(
            "Resource name '{name}' exceeds maximum length of 253 characters"
        )));
    }

    if !is_valid_dns_subdomain(name) {
        return Err(Error::InvalidInput(format!(
            "Resource name '{name}' is not a valid DNS-1123 subdomain. Must be lowercase alphanumeric characters, '-', or '.', and must start and end with an alphanumeric character. Each segment between dots must be 1-63 characters"
        )));
    }

    Ok(())
}

/// Validate a key of a `ConfigMap` or `Secret`.
///
/// Kubernetes accepts `[-._a-zA-Z0-9]+` here — a different, looser alphabet
/// than a resource name, and one that deliberately excludes `/`. Checked
/// rather than trusted because the key becomes a JSON Pointer segment in the
/// merge patch that writes it, and a `/` there would address a different
/// field entirely.
pub fn validate_config_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(Error::InvalidInput("Key cannot be empty".to_string()));
    }
    if key.len() > 253 {
        return Err(Error::InvalidInput(format!(
            "Key '{key}' exceeds maximum length of 253 characters"
        )));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(Error::InvalidInput(format!(
            "Key '{key}' is not a valid ConfigMap key. Must be alphanumeric characters, '-', '_' or '.'"
        )));
    }
    Ok(())
}

/// A name as the API server holds every kind to it, whatever else its kind
/// asks: one path segment. RBAC names such as `system:controller:x` are not
/// subdomains, so a reader of any kind can check no more than this.
pub fn validate_path_segment(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '%']) {
        return Err(Error::InvalidInput(format!(
            "'{name}' cannot be an object name"
        )));
    }
    Ok(())
}

/// Validate a Kubernetes namespace name (DNS-1123 label)
pub fn validate_namespace(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(Error::InvalidInput(
            "Namespace name cannot be empty".to_string(),
        ));
    }

    if name.len() > 63 {
        return Err(Error::InvalidInput(format!(
            "Namespace name '{name}' exceeds maximum length of 63 characters"
        )));
    }

    if !is_valid_dns_label(name) {
        return Err(Error::InvalidInput(format!(
            "Namespace name '{name}' is not a valid DNS-1123 label. Must be lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    /// The YAML tab reads any kind by the name it is handed. A `/` or a `..`
    /// in it would address another path on the API server.
    #[test]
    fn an_object_name_is_one_path_segment() {
        for good in ["web-0", "system:controller:node", "node.example.com"] {
            assert!(validate_path_segment(good).is_ok(), "{good}");
        }
        for bad in ["", ".", "..", "a/b", "../secrets", "a%2Fb"] {
            assert!(validate_path_segment(bad).is_err(), "{bad}");
        }
    }

    use super::*;

    /// A static pod is named after its node, and a node on EKS, kOps or
    /// `OpenShift` after its FQDN. Held to the label rule, both showed in the
    /// list and refused to open, delete or debug.
    #[test]
    fn a_pod_or_a_node_may_have_dots_in_its_name() {
        use k8s_openapi::api::core::v1::{Node, Pod};
        assert!(validate_name::<Pod>("kube-apiserver-ip-10-0-1-5.ec2.internal").is_ok());
        assert!(validate_name::<Node>("ip-10-0-1-5.us-west-2.compute.internal").is_ok());
        assert!(validate_name::<Pod>("Not-A-Name").is_err());
    }

    /// The two kinds whose name is a DNS label keep the stricter rule.
    #[test]
    fn a_service_or_a_namespace_may_not() {
        use k8s_openapi::api::core::v1::{Namespace, Service};
        assert!(validate_name::<Service>("api.v2").is_err());
        assert!(validate_name::<Namespace>("team.a").is_err());
        assert!(validate_name::<Service>("api-v2").is_ok());
    }

    #[test]
    fn test_validate_namespace() {
        assert!(validate_namespace("default").is_ok());
        assert!(validate_namespace("kube-system").is_ok());
        assert!(validate_namespace("").is_err());
        assert!(validate_namespace("Invalid").is_err()); // uppercase
        assert!(validate_namespace("my.namespace").is_err()); // dots not allowed
    }
}
