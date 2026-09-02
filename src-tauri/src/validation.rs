//! Input validation for Kubernetes resources

use crate::error::{Error, Result};
use crate::utils::{is_valid_dns_label, is_valid_dns_subdomain};

/// Validate a Kubernetes resource name as DNS-1123 label (no dots, max 63 chars)
/// Used for: Pod, Deployment, Service, `StatefulSet`, `DaemonSet`, Job, `CronJob`, Endpoints
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
    use super::*;

    #[test]
    fn test_validate_dns_label() {
        // Valid DNS labels
        assert!(validate_dns_label("valid-name").is_ok());
        assert!(validate_dns_label("valid-name-123").is_ok());
        assert!(validate_dns_label("a").is_ok());

        // Invalid DNS labels
        assert!(validate_dns_label("").is_err()); // empty
        assert!(validate_dns_label("Invalid-Name").is_err()); // uppercase
        assert!(validate_dns_label("-invalid").is_err()); // starts with dash
        assert!(validate_dns_label("invalid-").is_err()); // ends with dash
        assert!(validate_dns_label("my.name").is_err()); // contains dot
        assert!(validate_dns_label(&"a".repeat(64)).is_err()); // too long
    }

    #[test]
    fn test_validate_dns_subdomain() {
        // Valid DNS subdomains
        assert!(validate_dns_subdomain("valid-name").is_ok());
        assert!(validate_dns_subdomain("gateways.networking.istio.io").is_ok());
        assert!(validate_dns_subdomain("node-1.example.com").is_ok());
        assert!(validate_dns_subdomain("my.config.name").is_ok());

        // Invalid DNS subdomains
        assert!(validate_dns_subdomain("").is_err()); // empty
        assert!(validate_dns_subdomain("Invalid.Name").is_err()); // uppercase
        assert!(validate_dns_subdomain(".invalid").is_err()); // starts with dot
        assert!(validate_dns_subdomain("invalid.").is_err()); // ends with dot
        assert!(validate_dns_subdomain("invalid..name").is_err()); // consecutive dots
        assert!(validate_dns_subdomain("-invalid.name").is_err()); // segment starts with dash
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
