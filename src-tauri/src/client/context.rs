//! Kubernetes context management

use serde::{Deserialize, Serialize};

/// How a context proves who it is, as far as the kubeconfig admits.
///
/// This is a reading of the user entry, not a test of it: nothing here
/// contacts an API server. The last variant is the reason the enum exists
/// — a user entry the app cannot classify has to say so, because a row
/// that guesses "client certificate" and is wrong is worse than the form
/// it replaced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContextAuth {
    /// A credential plugin the app runs; the command is in `exec_command`.
    Exec,
    /// `source` is the file the certificate comes from, or `None` when
    /// the bytes are embedded in the kubeconfig itself.
    ClientCertificate {
        source: Option<String>,
    },
    /// `source` is the file the token is read from, or `None` when the
    /// token is written in the kubeconfig itself.
    Token {
        source: Option<String>,
    },
    Basic {
        username: Option<String>,
    },
    /// A legacy `auth-provider` block — `oidc`, `gcp`, `azure`.
    AuthProvider {
        name: String,
    },
    /// The user entry is missing, empty, or a shape this app has no name
    /// for. The screen says "cannot tell" rather than picking one.
    Unrecognised,
}

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
    /// What the user entry says the credential is. Settings prints this
    /// verbatim; nothing downstream branches on it.
    pub auth: ContextAuth,
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
    #[must_use]
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
    #[must_use]
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
            auth: ContextAuth::ClientCertificate { source: None },
        };

        assert_eq!(info.name, "test");
        assert!(info.is_current);
    }

    /// The screen reads this tag to decide what a row claims, so a rename
    /// that silently changes the wire shape would leave every row saying
    /// "cannot tell" about a context the file describes perfectly well.
    #[test]
    fn auth_serialises_as_a_tagged_kind() {
        let json = serde_json::to_string(&ContextAuth::ClientCertificate {
            source: Some("/home/u/.minikube/client.crt".to_string()),
        })
        .unwrap();
        assert!(json.contains(r#""kind":"clientCertificate""#), "{json}");
        assert!(json.contains("client.crt"), "{json}");
        assert_eq!(
            serde_json::to_string(&ContextAuth::Unrecognised).unwrap(),
            r#"{"kind":"unrecognised"}"#
        );
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
