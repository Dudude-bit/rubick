//! Native cloud SDK authentication (GKE / AKS) — the fast-path that
//! avoids spawning the cloud CLI when the user has profile-driven
//! native auth available.

use crate::auth::{
    is_aks_exec_command, is_gke_exec_command, parse_aks_exec_args, AuthProvider, AzureAksAuth,
    GcpGkeAuth,
};
use crate::cli::cloud::{AzTool, GcloudTool, GkeAuthPluginTool, KubeloginTool};
use crate::cli::CliToolManager;
use crate::config::AppConfig;
use crate::error::Result;
use kube::config::ExecConfig;
use std::path::PathBuf;

use super::cred::ExecCredentialStatus;

// Global cloud CLI managers
static GCLOUD: std::sync::LazyLock<CliToolManager<GcloudTool>> =
    std::sync::LazyLock::new(|| CliToolManager::new(GcloudTool::new()));

static GKE_AUTH_PLUGIN: std::sync::LazyLock<CliToolManager<GkeAuthPluginTool>> =
    std::sync::LazyLock::new(|| CliToolManager::new(GkeAuthPluginTool::new()));

static AZ: std::sync::LazyLock<CliToolManager<AzTool>> =
    std::sync::LazyLock::new(|| CliToolManager::new(AzTool::new()));

static KUBELOGIN: std::sync::LazyLock<CliToolManager<KubeloginTool>> =
    std::sync::LazyLock::new(|| CliToolManager::new(KubeloginTool::new()));

/// Try native authentication for cloud providers (GKE, AKS).
/// Returns `None` if native auth is not applicable or disabled.
pub(super) async fn try_native_cloud_auth(
    exec: &ExecConfig,
    context: &str,
) -> Option<Result<ExecCredentialStatus>> {
    let command = exec.command.as_ref()?;
    let config = AppConfig::load().ok()?;

    // Try GKE native auth
    if is_gke_exec_command(command) {
        // Get profile for this context, or use defaults (ADC)
        let gcp_profile = config.cloud.get_gcp_profile_for_context(context);
        let prefer_native = gcp_profile.is_none_or(|p| p.prefer_native_auth);

        if prefer_native {
            tracing::info!(
                "Attempting native GCP authentication for context: {}",
                context
            );

            let service_account_path = gcp_profile
                .and_then(|p| p.service_account_key_path.clone())
                .map(std::path::PathBuf::from);
            let auth = GcpGkeAuth::new(service_account_path);

            match auth.authenticate().await {
                Ok(result) => {
                    tracing::info!("Native GCP authentication successful");
                    return Some(Ok(ExecCredentialStatus {
                        expiration_timestamp: result.expires_at.map(|t| t.to_rfc3339()),
                        token: Some(result.token),
                        client_certificate_data: None,
                        client_key_data: None,
                    }));
                }
                Err(e) => {
                    tracing::warn!(
                        "Native GCP authentication failed, will try exec fallback: {}",
                        e
                    );
                    // Continue to exec fallback
                }
            }
        }
    }

    // Try AKS native auth
    if is_aks_exec_command(command) {
        // Get profile for this context, or use defaults
        let azure_profile = config.cloud.get_azure_profile_for_context(context);
        let prefer_native = azure_profile.is_none_or(|p| p.prefer_native_auth);

        if prefer_native {
            tracing::info!(
                "Attempting native Azure authentication for context: {}",
                context
            );

            let aks_info = exec
                .args
                .as_ref()
                .and_then(|args| parse_aks_exec_args(args));
            let tenant_id = aks_info
                .as_ref()
                .and_then(|i| i.tenant_id.clone())
                .or_else(|| azure_profile.and_then(|p| p.tenant_id.clone()));

            let use_cli_fallback = azure_profile.is_some_and(|p| p.use_cli_fallback);
            let auth = AzureAksAuth::new(use_cli_fallback, tenant_id);

            match auth.authenticate().await {
                Ok(result) => {
                    tracing::info!("Native Azure authentication successful");
                    return Some(Ok(ExecCredentialStatus {
                        expiration_timestamp: result.expires_at.map(|t| t.to_rfc3339()),
                        token: Some(result.token),
                        client_certificate_data: None,
                        client_key_data: None,
                    }));
                }
                Err(e) => {
                    tracing::warn!(
                        "Native Azure authentication failed, will try exec fallback: {}",
                        e
                    );
                    // Continue to exec fallback
                }
            }
        }
    }

    None
}

/// Resolve cloud CLI binary path using unified CLI infrastructure.
pub(super) async fn resolve_cloud_cli_path(command: &str) -> Option<PathBuf> {
    // Check if command is already an absolute path
    let cmd_path = PathBuf::from(command);
    if cmd_path.is_absolute() && cmd_path.exists() {
        return Some(cmd_path);
    }

    // Use appropriate CLI manager based on command type
    if is_gke_exec_command(command) {
        // Try gke-gcloud-auth-plugin first, then gcloud
        if let Ok(path) = GKE_AUTH_PLUGIN.resolve_path().await {
            return Some(path);
        }
        if let Ok(path) = GCLOUD.resolve_path().await {
            return Some(path);
        }
    }

    if is_aks_exec_command(command) {
        // Try kubelogin first, then az
        if let Ok(path) = KUBELOGIN.resolve_path().await {
            return Some(path);
        }
        if let Ok(path) = AZ.resolve_path().await {
            return Some(path);
        }
    }

    None
}
