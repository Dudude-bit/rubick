//! Kubernetes context management

use serde::{Deserialize, Serialize};

/// Information about a Kubernetes context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextInfo {
    /// Context name
    pub name: String,
    /// Cluster name
    pub cluster: String,
    /// User name
    pub user: String,
    /// Default namespace
    pub namespace: Option<String>,
    /// Whether this is the current context
    pub is_current: bool,
    /// The cluster's API server URL, verbatim from the kubeconfig.
    ///
    /// This and `exec_command` exist so the connecting and failed screens
    /// can print what the app is actually doing rather than a plausible
    /// sentence about it. `None` means the kubeconfig does not say.
    pub server: Option<String>,
    /// The credential plugin this context runs before it can talk to the
    /// API server — `command` plus its `args`, joined the way a shell
    /// would print them. `None` when the context authenticates without
    /// one (a client certificate, a static token, an OIDC provider).
    pub exec_command: Option<String>,
}

/// Represents a Kubernetes cluster context with connection details
#[derive(Debug, Clone)]
pub struct ClusterContext {
    /// Context name
    pub name: String,
    /// Cluster endpoint URL
    pub server: String,
    /// Cluster CA certificate (base64 encoded)
    pub certificate_authority_data: Option<String>,
    /// Whether to skip TLS verification
    pub insecure_skip_tls_verify: bool,
    /// Default namespace for this context
    pub default_namespace: String,
}

impl ClusterContext {
    /// Create a new cluster context
    pub fn new(name: impl Into<String>, server: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            server: server.into(),
            certificate_authority_data: None,
            insecure_skip_tls_verify: false,
            default_namespace: "default".to_string(),
        }
    }

    /// Set the CA certificate data
    pub fn with_ca_data(mut self, ca_data: impl Into<String>) -> Self {
        self.certificate_authority_data = Some(ca_data.into());
        self
    }

    /// Set insecure TLS verification
    #[must_use]
    pub fn with_insecure_tls(mut self, insecure: bool) -> Self {
        self.insecure_skip_tls_verify = insecure;
        self
    }

    /// Set the default namespace
    pub fn with_namespace(mut self, namespace: impl Into<String>) -> Self {
        self.default_namespace = namespace.into();
        self
    }
}

impl Default for ClusterContext {
    fn default() -> Self {
        Self {
            name: "default".to_string(),
            server: "https://localhost:6443".to_string(),
            certificate_authority_data: None,
            insecure_skip_tls_verify: false,
            default_namespace: "default".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_context_info() {
        let info = ContextInfo {
            name: "test".to_string(),
            cluster: "test-cluster".to_string(),
            user: "test-user".to_string(),
            namespace: Some("default".to_string()),
            is_current: true,
            server: Some("https://127.0.0.1:6443".to_string()),
            exec_command: None,
        };

        assert_eq!(info.name, "test");
        assert!(info.is_current);
    }

    #[test]
    fn test_cluster_context_builder() {
        let ctx = ClusterContext::new("prod", "https://k8s.example.com:6443")
            .with_namespace("production")
            .with_insecure_tls(false);

        assert_eq!(ctx.name, "prod");
        assert_eq!(ctx.default_namespace, "production");
        assert!(!ctx.insecure_skip_tls_verify);
    }
}
