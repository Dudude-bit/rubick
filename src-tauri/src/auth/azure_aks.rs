//! Azure AKS native authentication provider
//!
//! Provides native authentication for Azure Kubernetes Service clusters
//! using the `azure_identity` crate instead of relying on `kubelogin` or `az` CLI.

use super::{AuthProvider, AuthResult};
use crate::error::{AuthError, Error, Result};
use async_trait::async_trait;
use azure_core::credentials::{Secret, TokenCredential};
use std::sync::Arc;

/// Which sign-in Azure is actually asked for.
///
/// `DefaultAzureCredential` used to decide this invisibly, and `azure_identity`
/// 1.0 removed it on purpose. Two of the legs it walked — managed identity and
/// workload identity — can only ever succeed for code running *inside* Azure,
/// which a desktop client is not; asking for them here only bought a slower
/// failure. What is left is the two that can work on somebody's laptop.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    /// A service principal named by the environment, the way CI and scripted
    /// setups supply one.
    ServicePrincipal {
        tenant_id: String,
        client_id: String,
        secret: String,
    },
    /// Whatever `az login` left behind, for the tenant if one is known.
    AzureCli { tenant_id: Option<String> },
}

impl Source {
    /// A service principal needs all three parts; two of them is a half-filled
    /// environment, not a credential, and trying it would report the wrong
    /// problem to somebody who is simply logged in with `az`.
    fn pick(tenant_id: Option<String>, client_id: Option<String>, secret: Option<String>) -> Self {
        let full = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
        match (full(tenant_id.clone()), full(client_id), full(secret)) {
            (Some(tenant_id), Some(client_id), Some(secret)) => Self::ServicePrincipal {
                tenant_id,
                client_id,
                secret,
            },
            _ => Self::AzureCli {
                tenant_id: full(tenant_id),
            },
        }
    }
}

/// Azure AKS authentication provider
///
/// Uses `azure_identity` to obtain access tokens through:
/// - a service principal from the environment, when one is fully specified
/// - Azure CLI credentials
pub struct AzureAksAuth {
    /// Whether to fall back to `az login` when a service principal fails.
    ///
    /// This used to be close to meaningless: the old chain tried the CLI
    /// itself, so the flag only bought a second identical attempt. Now it
    /// decides something real — with it off, a service principal that fails
    /// says so instead of being quietly covered for by whoever is logged in.
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
        let source = self.source();
        let credential = Self::credential(&source)?;

        match self.fetch_token(credential.as_ref()).await {
            Ok(result) => Ok(result),
            // Only worth a second attempt when the first one was something
            // else. If the CLI is what already failed there is nothing left
            // to fall back to, and retrying it would just repeat the error
            // under a misleading heading.
            Err(e)
                if self.use_cli_fallback && matches!(source, Source::ServicePrincipal { .. }) =>
            {
                tracing::warn!("Service principal sign-in failed, trying Azure CLI: {}", e);
                self.get_token_with_cli().await
            }
            Err(e) => Err(e),
        }
    }

    /// Which credential this provider will present.
    ///
    /// A tenant named by the kubeconfig wins over one named by the
    /// environment: it is the one that describes *this* cluster.
    fn source(&self) -> Source {
        self.source_from(|key| std::env::var(key).ok())
    }

    /// The same choice against a named environment, so a test can make one.
    fn source_from(&self, env: impl Fn(&str) -> Option<String>) -> Source {
        Source::pick(
            self.tenant_id.clone().or_else(|| env("AZURE_TENANT_ID")),
            env("AZURE_CLIENT_ID"),
            env("AZURE_CLIENT_SECRET"),
        )
    }

    /// Build the credential a source describes.
    fn credential(source: &Source) -> Result<Arc<dyn TokenCredential>> {
        let built: Arc<dyn TokenCredential> = match source {
            Source::ServicePrincipal {
                tenant_id,
                client_id,
                secret,
            } => azure_identity::ClientSecretCredential::new(
                tenant_id,
                client_id.clone(),
                Secret::new(secret.clone()),
                None,
            )
            .map_err(|e| {
                Error::Auth(AuthError::AzureAuth(format!(
                    "Failed to create Azure credential: {e}"
                )))
            })?,
            Source::AzureCli { tenant_id } => {
                // The tenant travels as an option rather than through
                // `AZURE_TENANT_ID`, which is what the old code set. That was
                // a process-wide write: connect to a cluster in one tenant and
                // every later cluster that named none inherited it.
                let options =
                    tenant_id
                        .clone()
                        .map(|tenant_id| azure_identity::AzureCliCredentialOptions {
                            tenant_id: Some(tenant_id),
                            ..Default::default()
                        });
                azure_identity::AzureCliCredential::new(options).map_err(|e| {
                    Error::Auth(AuthError::AzureAuth(format!(
                        "Failed to create Azure credential: {e}"
                    )))
                })?
            }
        };
        Ok(built)
    }

    /// Fetch token using the provided credential
    async fn fetch_token(
        &self,
        credential: &dyn TokenCredential,
    ) -> Result<(String, Option<chrono::DateTime<chrono::Utc>>)> {
        let token_response = credential
            .get_token(&[&self.scope], None)
            .await
            .map_err(|e| {
                Error::Auth(AuthError::AzureAuth(format!(
                    "Failed to obtain Azure access token: {e}. \
                     Ensure you are logged in with 'az login' or have valid Azure credentials configured."
                )))
            })?;

        Ok(Self::read(&token_response))
    }

    /// Fallback to Azure CLI credentials
    async fn get_token_with_cli(&self) -> Result<(String, Option<chrono::DateTime<chrono::Utc>>)> {
        let credential = Self::credential(&Source::AzureCli {
            tenant_id: self.tenant_id.clone(),
        })?;

        let token_response = credential
            .get_token(&[&self.scope], None)
            .await
            .map_err(|e| {
                Error::Auth(AuthError::AzureAuth(format!(
                    "Azure CLI authentication failed: {e}. \
                     Please run 'az login' to authenticate."
                )))
            })?;

        Ok(Self::read(&token_response))
    }

    /// The two things this app wants out of an access token.
    fn read(
        token_response: &azure_core::credentials::AccessToken,
    ) -> (String, Option<chrono::DateTime<chrono::Utc>>) {
        let token = token_response.token.secret().to_string();
        let expires_at = chrono::DateTime::<chrono::Utc>::from_timestamp(
            token_response.expires_on.unix_timestamp(),
            0,
        );
        (token, expires_at)
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

    /// A named environment, so these say what they mean regardless of whose
    /// machine runs them.
    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let named: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |key| named.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }

    #[test]
    fn a_fully_named_service_principal_is_the_one_used() {
        let auth = AzureAksAuth::new(true, None);
        let source = auth.source_from(env_of(&[
            ("AZURE_TENANT_ID", "t"),
            ("AZURE_CLIENT_ID", "c"),
            ("AZURE_CLIENT_SECRET", "s"),
        ]));
        assert_eq!(
            source,
            Source::ServicePrincipal {
                tenant_id: "t".to_string(),
                client_id: "c".to_string(),
                secret: "s".to_string(),
            }
        );
    }

    /// Two thirds of a service principal is a half-filled environment. Trying
    /// it would report a missing secret to somebody who is simply logged in
    /// with `az` and never asked for one.
    #[test]
    fn a_half_named_service_principal_is_not_used_at_all() {
        let auth = AzureAksAuth::new(true, None);
        for env in [
            vec![("AZURE_TENANT_ID", "t"), ("AZURE_CLIENT_ID", "c")],
            vec![("AZURE_TENANT_ID", "t"), ("AZURE_CLIENT_SECRET", "s")],
            vec![
                ("AZURE_TENANT_ID", "t"),
                ("AZURE_CLIENT_ID", "c"),
                ("AZURE_CLIENT_SECRET", "   "),
            ],
        ] {
            assert_eq!(
                auth.source_from(env_of(&env)),
                Source::AzureCli {
                    tenant_id: Some("t".to_string())
                },
                "for {env:?}"
            );
        }
    }

    /// The kubeconfig describes *this* cluster; the environment describes the
    /// machine. When both name a tenant the cluster's is the right one.
    #[test]
    fn the_tenant_from_the_kubeconfig_beats_the_one_from_the_environment() {
        let auth = AzureAksAuth::new(true, Some("from-kubeconfig".to_string()));
        assert_eq!(
            auth.source_from(env_of(&[("AZURE_TENANT_ID", "from-environment")])),
            Source::AzureCli {
                tenant_id: Some("from-kubeconfig".to_string())
            }
        );
    }

    /// The old code passed the tenant by writing `AZURE_TENANT_ID`, which is
    /// process-wide: a cluster in one tenant left it set for every cluster
    /// asked about afterwards, and one that named no tenant silently borrowed
    /// it. Asking about the second cluster must come back empty-handed.
    #[test]
    fn a_tenant_does_not_leak_from_one_cluster_to_the_next() {
        let env = env_of(&[]);
        let first = AzureAksAuth::new(true, Some("tenant-a".to_string()));
        assert_eq!(
            first.source_from(&env),
            Source::AzureCli {
                tenant_id: Some("tenant-a".to_string())
            }
        );

        let second = AzureAksAuth::new(true, None);
        assert_eq!(
            second.source_from(&env),
            Source::AzureCli { tenant_id: None }
        );
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
}
