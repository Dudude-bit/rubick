//! Utility functions and helpers

pub mod quantities;

pub use quantities::{format_cpu, format_memory, parse_cpu, parse_memory};

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use regex::Regex;

/// Format age from Kubernetes Time.
#[must_use]
pub fn format_k8s_age(created_at: Option<&Time>) -> String {
    let parsed = created_at
        .and_then(|time| chrono::DateTime::parse_from_rfc3339(&time.0.to_rfc3339()).ok())
        .map(|t| t.with_timezone(&chrono::Utc));
    k8s_gui_common::datetime::format_age(parsed.as_ref())
}

/// Normalize namespace input, returning None for "all namespaces".
#[must_use]
pub fn normalize_namespace(namespace: Option<String>, fallback: String) -> Option<String> {
    normalize_optional_namespace(namespace).or_else(|| normalize_optional_namespace(Some(fallback)))
}

/// Normalize optional namespace input, returning None for empty/whitespace.
#[must_use]
pub fn normalize_optional_namespace(namespace: Option<String>) -> Option<String> {
    namespace.and_then(|ns| {
        let trimmed = ns.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// Milliseconds elapsed since `started`, saturating instead of wrapping.
///
/// Every caller is timing one round trip to put a number in a log line, so
/// the saturation point is not a case anybody has to reason about.
#[must_use]
pub fn elapsed_ms(started: std::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Generate a unique ID with a given prefix
#[must_use]
pub fn generate_id(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4())
}

/// Require a concrete namespace, returning an error when "all namespaces" is selected.
///
/// # Errors
///
/// Returns an error if both namespace and fallback are empty or represent "all namespaces".
pub fn require_namespace(
    namespace: Option<String>,
    fallback: String,
) -> crate::error::Result<String> {
    normalize_namespace(namespace, fallback).ok_or_else(|| {
        crate::error::Error::InvalidInput(
            "Namespace is required for this operation when all namespaces is selected.".to_string(),
        )
    })
}

// Compile regex patterns once at startup
// DNS-1123 label: lowercase alphanumeric or '-', must start/end with alphanumeric, max 63 chars
static DNS_LABEL_REGEX: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$").expect("Failed to compile DNS label regex")
});

// DNS-1123 subdomain: lowercase alphanumeric, '-', or '.', must start/end with alphanumeric, max 253 chars
// Each segment between dots must be a valid DNS label (1-63 chars)
static DNS_SUBDOMAIN_REGEX: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$")
        .expect("Failed to compile DNS subdomain regex")
});

/// Check if a string is a valid DNS-1123 label (no dots allowed, max 63 chars)
/// Used for: Pod, Deployment, Service, `StatefulSet`, `DaemonSet`, Job, `CronJob`, Namespace, Endpoints
pub fn is_valid_dns_label(name: &str) -> bool {
    if name.is_empty() || name.len() > 63 {
        return false;
    }
    DNS_LABEL_REGEX.is_match(name)
}

/// Check if a string is a valid DNS-1123 subdomain (dots allowed, max 253 chars, each segment max 63 chars)
/// Used for: CRD names, Node names, `ConfigMap`, Secret, PV, PVC, `StorageClass`, Ingress, Helm releases
pub fn is_valid_dns_subdomain(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 {
        return false;
    }

    // Check overall pattern
    if !DNS_SUBDOMAIN_REGEX.is_match(name) {
        return false;
    }

    // Check each segment is <= 63 chars
    for segment in name.split('.') {
        if segment.len() > 63 {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_dns_label() {
        // Valid DNS labels
        assert!(is_valid_dns_label("my-app"));
        assert!(is_valid_dns_label("app123"));
        assert!(is_valid_dns_label("a"));
        assert!(is_valid_dns_label("a-b-c"));

        // Invalid DNS labels
        assert!(!is_valid_dns_label("My-App")); // uppercase
        assert!(!is_valid_dns_label("-app")); // starts with dash
        assert!(!is_valid_dns_label("app-")); // ends with dash
        assert!(!is_valid_dns_label("")); // empty
        assert!(!is_valid_dns_label("my.app")); // contains dot
        assert!(!is_valid_dns_label(&"a".repeat(64))); // too long (> 63)
    }

    #[test]
    fn test_is_valid_dns_subdomain() {
        // Valid DNS subdomains
        assert!(is_valid_dns_subdomain("my-app"));
        assert!(is_valid_dns_subdomain("gateways.networking.istio.io"));
        assert!(is_valid_dns_subdomain("node-1.example.com"));
        assert!(is_valid_dns_subdomain("my.config.map"));
        assert!(is_valid_dns_subdomain("a.b.c"));

        // Invalid DNS subdomains
        assert!(!is_valid_dns_subdomain("")); // empty
        assert!(!is_valid_dns_subdomain("My.App")); // uppercase
        assert!(!is_valid_dns_subdomain(".app")); // starts with dot
        assert!(!is_valid_dns_subdomain("app.")); // ends with dot
        assert!(!is_valid_dns_subdomain("app..name")); // consecutive dots
        assert!(!is_valid_dns_subdomain("-app.name")); // segment starts with dash
        assert!(!is_valid_dns_subdomain("app-.name")); // segment ends with dash

        // Segment too long (> 63 chars)
        let long_segment = "a".repeat(64);
        assert!(!is_valid_dns_subdomain(&format!(
            "{long_segment}.example.com"
        )));

        // Total too long (> 253 chars)
        let long_name = format!("{}.{}.{}", "a".repeat(63), "b".repeat(63), "c".repeat(128));
        assert!(!is_valid_dns_subdomain(&long_name));
    }

    #[test]
    fn test_normalize_namespace() {
        assert_eq!(
            normalize_namespace(Some("default".to_string()), "ignored".to_string()),
            Some("default".to_string())
        );
        // Empty string falls back to fallback
        assert_eq!(
            normalize_namespace(Some(String::new()), "default".to_string()),
            Some("default".to_string())
        );
        assert_eq!(
            normalize_namespace(None, "default".to_string()),
            Some("default".to_string())
        );
        // Both empty - returns None
        assert_eq!(normalize_namespace(None, String::new()), None);
        assert_eq!(
            normalize_namespace(Some(String::new()), String::new()),
            None
        );
    }

    #[test]
    fn test_normalize_optional_namespace() {
        assert_eq!(
            normalize_optional_namespace(Some("default".to_string())),
            Some("default".to_string())
        );
        assert_eq!(normalize_optional_namespace(Some(" ".to_string())), None);
        assert_eq!(
            normalize_optional_namespace(Some(" kube-system ".to_string())),
            Some("kube-system".to_string())
        );
        assert_eq!(normalize_optional_namespace(None), None);
    }

    #[test]
    fn test_require_namespace() {
        assert_eq!(
            require_namespace(Some("default".to_string()), "ignored".to_string()).unwrap(),
            "default".to_string()
        );
        // Empty namespace falls back to fallback successfully
        assert_eq!(
            require_namespace(Some(String::new()), "default".to_string()).unwrap(),
            "default".to_string()
        );
        // Both empty - error
        assert!(require_namespace(None, String::new()).is_err());
        assert!(require_namespace(Some(String::new()), String::new()).is_err());
    }
}
