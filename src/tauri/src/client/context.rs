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
}
