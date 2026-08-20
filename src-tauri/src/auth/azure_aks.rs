//! Azure AKS native authentication provider
//!
//! Provides native authentication for Azure Kubernetes Service clusters
//! using the `azure_identity` crate instead of relying on `kubelogin` or `az` CLI.

use super::{AuthProvider, AuthResult};
use crate::error::{AuthError, Error, Result};
use async_trait::async_trait;
use azure_core::auth::TokenCredential;

/// Azure AKS authentication provider
///
/// Uses `azure_identity` to obtain access tokens through:
/// - `DefaultAzureCredential` chain (environment, managed identity, CLI, etc.)
/// - Azure CLI credentials (fallback option)
pub struct AzureAksAuth {
    /// Whether to use Azure CLI credentials as fallback
    use_cli_fallback: bool,
    /// Tenant ID for authentication (optional)
    tenant_id: Option<String>,
    /// The Azure AD scope for AKS
    scope: String,
}

impl AzureAksAuth {
    /// Create a new Azure AKS auth provider
    ///
    /// # Arguments
    ///
    /// * `use_cli_fallback` - If true, will try Azure CLI credentials when default chain fails
    /// * `tenant_id` - Optional tenant ID to use for authentication
    #[must_use]
    pub fn new(use_cli_fallback: bool, tenant_id: Option<String>) -> Self {
        Self {
            use_cli_fallback,
            tenant_id,
            // Default scope for AKS/AAD
            scope: "6dae42f8-4368-4678-94ff-3960e28e3630/.default".to_string(),
        }
    }

    /// Get an access token using `azure_identity`
    async fn get_token(&self) -> Result<(String, Option<chrono::DateTime<chrono::Utc>>)> {
        // Try DefaultAzureCredential first
        let credential = self.create_credential()?;

        match self.fetch_token(&credential).await {
            Ok(result) => Ok(result),
            Err(e) if self.use_cli_fallback => {
                tracing::warn!(
                    "DefaultAzureCredential failed, trying Azure CLI fallback: {}",
                    e
                );
                self.get_token_with_cli().await
            }
            Err(e) => Err(e),
        }
    }

    /// Create the `DefaultAzureCredential`
    fn create_credential(&self) -> Result<azure_identity::DefaultAzureCredential> {
        // Set AZURE_TENANT_ID environment variable if tenant_id is provided
        // This is used by EnvironmentCredential in the DefaultAzureCredential chain
        if let Some(ref tenant) = self.tenant_id {
            std::env::set_var("AZURE_TENANT_ID", tenant);
        }

        azure_identity::DefaultAzureCredential::create(
            azure_identity::TokenCredentialOptions::default(),
        )
        .map_err(|e| {
            Error::Auth(AuthError::AzureAuth(format!(
                "Failed to create Azure credential: {e}"
            )))
        })
    }

    /// Fetch token using the provided credential
    async fn fetch_token(
        &self,
        credential: &azure_identity::DefaultAzureCredential,
    ) -> Result<(String, Option<chrono::DateTime<chrono::Utc>>)> {
        let token_response = credential
            .get_token(&[&self.scope])
            .await
            .map_err(|e| {
                Error::Auth(AuthError::AzureAuth(format!(
                    "Failed to obtain Azure access token: {e}. \
                     Ensure you are logged in with 'az login' or have valid Azure credentials configured."
                )))
            })?;

        let token = token_response.token.secret().to_string();

        // Convert expiry time
        let expires_at = {
            let unix_timestamp = token_response.expires_on.unix_timestamp();
            chrono::DateTime::<chrono::Utc>::from_timestamp(unix_timestamp, 0)
        };

        Ok((token, expires_at))
    }

    /// Fallback to Azure CLI credentials
    async fn get_token_with_cli(&self) -> Result<(String, Option<chrono::DateTime<chrono::Utc>>)> {
        let credential = azure_identity::AzureCliCredential::new();

        let token_response = credential.get_token(&[&self.scope]).await.map_err(|e| {
            Error::Auth(AuthError::AzureAuth(format!(
                "Azure CLI authentication failed: {e}. \
                     Please run 'az login' to authenticate."
            )))
        })?;

        let token = token_response.token.secret().to_string();

        let expires_at = {
            let unix_timestamp = token_response.expires_on.unix_timestamp();
            chrono::DateTime::<chrono::Utc>::from_timestamp(unix_timestamp, 0)
        };

        Ok((token, expires_at))
    }
}

#[async_trait]
impl AuthProvider for AzureAksAuth {
    async fn authenticate(&self) -> Result<AuthResult> {
        let (token, expires_at) = self.get_token().await?;

        Ok(AuthResult {
            token,
            expires_at,
            refresh_token: None,
            token_type: "Bearer".to_string(),
        })
    }

    async fn refresh(&self, _auth: &AuthResult) -> Result<AuthResult> {
        // Azure tokens can be refreshed by obtaining a new one
        // The azure_identity library handles caching and refresh internally
        self.authenticate().await
    }

    fn supports_refresh(&self) -> bool {
        true
    }

    fn name(&self) -> &'static str {
        "azure_aks"
    }
}

/// Detect if an exec command is for AKS authentication
///
/// Returns true if the command appears to be an AKS auth plugin (kubelogin)
#[must_use]
pub fn is_aks_exec_command(command: &str) -> bool {
    let cmd_lower = command.to_lowercase();
    cmd_lower.contains("kubelogin")
        || cmd_lower.contains("azure")
        || (cmd_lower.contains("az") && !cmd_lower.contains("amazon"))
}

/// Extract AKS cluster info from exec args if present
#[must_use]
pub fn parse_aks_exec_args(args: &[String]) -> Option<AksClusterInfo> {
    let mut server_id = None;
    let mut tenant_id = None;
    let mut environment = None;

    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--server-id" | "-s" => {
                server_id = iter.next().cloned();
            }
            "--tenant-id" | "-t" => {
                tenant_id = iter.next().cloned();
            }
            "--environment" | "-e" => {
                environment = iter.next().cloned();
            }
            _ => {
                // Check for --arg=value format
                if let Some((key, value)) = arg.split_once('=') {
                    match key {
                        "--server-id" | "-s" => server_id = Some(value.to_string()),
                        "--tenant-id" | "-t" => tenant_id = Some(value.to_string()),
                        "--environment" | "-e" => environment = Some(value.to_string()),
                        _ => {}
                    }
                }
            }
        }
    }

    // We can still create auth info even without all fields
    Some(AksClusterInfo {
        server_id,
        tenant_id,
        environment: environment.unwrap_or_else(|| "AzurePublicCloud".to_string()),
    })
}

/// AKS cluster information parsed from exec args
#[derive(Debug, Clone)]
pub struct AksClusterInfo {
    /// The AAD server application ID (scope)
    pub server_id: Option<String>,
    /// Azure tenant ID
    pub tenant_id: Option<String>,
    /// Azure environment (e.g., `AzurePublicCloud`, `AzureChinaCloud`)
    pub environment: String,
}

impl AksClusterInfo {
    /// Parse AKS cluster info from a kubeconfig context name
    ///
    /// AKS contexts typically follow the format: `CLUSTER_NAME` or `RESOURCE_GROUP_CLUSTER`
    /// Unlike GKE, AKS doesn't encode as much info in the context name
    #[must_use]
    pub fn from_context_name(context: &str) -> Option<Self> {
        // AKS context names don't have a standard format with embedded info
        // We can only detect if it might be an AKS cluster
        if context.contains("aks") || context.contains("azure") {
            Some(Self {
                server_id: None,
                tenant_id: None,
                environment: "AzurePublicCloud".to_string(),
            })
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_azure_aks_auth_creation() {
        let auth = AzureAksAuth::new(false, None);
        assert_eq!(auth.name(), "azure_aks");
        assert!(auth.supports_refresh());
    }

    #[test]
    fn test_azure_aks_auth_with_tenant() {
        let auth = AzureAksAuth::new(true, Some("tenant-id".to_string()));
        assert_eq!(auth.name(), "azure_aks");
    }

    #[test]
    fn test_is_aks_exec_command() {
        assert!(is_aks_exec_command("kubelogin"));
        assert!(is_aks_exec_command("/usr/local/bin/kubelogin"));
        assert!(is_aks_exec_command("azure-kubelogin"));
        assert!(!is_aks_exec_command("gke-gcloud-auth-plugin"));
        assert!(!is_aks_exec_command("aws-iam-authenticator"));
    }

    #[test]
    fn test_parse_aks_exec_args() {
        let args = vec![
            "get-token".to_string(),
            "--server-id".to_string(),
            "6dae42f8-4368-4678-94ff-3960e28e3630".to_string(),
            "--tenant-id".to_string(),
            "my-tenant-id".to_string(),
        ];

        let info = parse_aks_exec_args(&args);
        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(
            info.server_id,
            Some("6dae42f8-4368-4678-94ff-3960e28e3630".to_string())
        );
        assert_eq!(info.tenant_id, Some("my-tenant-id".to_string()));
    }

    #[test]
    fn test_aks_cluster_info_from_context() {
        let info = AksClusterInfo::from_context_name("my-aks-cluster");
        assert!(info.is_some());

        let info = AksClusterInfo::from_context_name("minikube");
        assert!(info.is_none());
    }
}
