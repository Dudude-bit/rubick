//! Authentication module
//!
//! Native providers for the clouds whose token endpoints this app talks to
//! directly: OIDC, GCP GKE and Azure AKS.
//!
//! Everything else — EKS included — authenticates through the kubeconfig
//! `exec` block, the same credential plugin `kubectl` runs. See
//! `interactive` for that path, and Settings -> Diagnostics for what it
//! reports when a plugin is missing.

mod azure_aks;
mod gcp_gke;
mod interactive;
mod kubeconfig_tokens;
mod oidc;

pub use azure_aks::{is_aks_exec_command, parse_aks_exec_args, AksClusterInfo, AzureAksAuth};
pub use gcp_gke::{is_gke_exec_command, GcpGkeAuth};
pub use interactive::prepare_kubeconfig_for_context;
pub use oidc::OidcAuth;

use serde::{Deserialize, Serialize};

/// Authentication result with token and expiry.
///
/// Note: `Debug` is implemented manually so the access and refresh
/// tokens never leak into logs / panic messages / `dbg!()`. Serde
/// still round-trips the full struct because that's intentional —
/// callers explicitly reach for serialization.
#[derive(Clone, Serialize, Deserialize)]
pub struct AuthResult {
    /// Access token or credential
    pub token: String,

    /// Token expiry timestamp (if known)
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,

    /// Refresh token (for OIDC)
    pub refresh_token: Option<String>,

    /// Token type (Bearer, etc.)
    pub token_type: String,
}

impl std::fmt::Debug for AuthResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthResult")
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("token_type", &self.token_type)
            .finish()
    }
}

impl AuthResult {
    /// Check if the token is expired
    #[must_use]
    pub fn is_expired(&self) -> bool {
        if let Some(expires_at) = self.expires_at {
            expires_at < chrono::Utc::now()
        } else {
            false
        }
    }
}

/// Trait for authentication providers
#[async_trait::async_trait]
pub trait AuthProvider: Send + Sync {
    /// Get authentication token/credentials
    async fn authenticate(&self) -> crate::error::Result<AuthResult>;

    /// Refresh authentication if supported
    async fn refresh(&self, auth: &AuthResult) -> crate::error::Result<AuthResult>;

    /// Check if refresh is supported
    fn supports_refresh(&self) -> bool;

    /// Get provider name
    fn name(&self) -> &'static str;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_result_expiry() {
        let result = AuthResult {
            token: "test".to_string(),
            expires_at: Some(chrono::Utc::now() - chrono::Duration::hours(1)),
            refresh_token: None,
            token_type: "Bearer".to_string(),
        };

        assert!(result.is_expired());
    }

    #[test]
    fn test_auth_result_not_expired() {
        let result = AuthResult {
            token: "test".to_string(),
            expires_at: Some(chrono::Utc::now() + chrono::Duration::hours(1)),
            refresh_token: None,
            token_type: "Bearer".to_string(),
        };

        assert!(!result.is_expired());
    }
}
