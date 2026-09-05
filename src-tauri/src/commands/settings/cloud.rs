//! Cloud auth profile commands — GCP profiles, Azure profiles, kubeconfig
//! context bindings, CLI tool paths and the kubeconfig path override.

use crate::auth::AuthProvider;
use crate::config::{AppConfig, AzureProfile, CliPathsConfig, ContextBinding, GcpProfile};
use crate::error::Result;
use serde::{Deserialize, Serialize};

use super::helpers::{read_config, with_config};

// --- GCP profiles -----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpProfileInfo {
    pub name: String,
    pub profile: GcpProfile,
}

#[tauri::command]
pub fn list_gcp_profiles() -> Result<Vec<GcpProfileInfo>> {
    read_config(|config| {
        config
            .cloud
            .gcp_profiles
            .iter()
            .map(|(name, profile)| GcpProfileInfo {
                name: name.clone(),
                profile: profile.clone(),
            })
            .collect()
    })
}

#[tauri::command]
pub fn save_gcp_profile(name: String, profile: GcpProfile) -> Result<()> {
    with_config(|config| {
        config
            .cloud
            .gcp_profiles
            .insert(name, profile.clean_empty_strings());
    })
}

#[tauri::command]
pub fn delete_gcp_profile(name: String) -> Result<()> {
    with_config(|config| {
        config.cloud.gcp_profiles.remove(&name);
        // Also remove any context bindings using this profile
        for binding in config.cloud.context_bindings.values_mut() {
            if binding.gcp_profile.as_ref() == Some(&name) {
                binding.gcp_profile = None;
            }
        }
    })
}

#[tauri::command]
pub async fn test_gcp_profile(name: String) -> Result<String> {
    use crate::auth::GcpGkeAuth;

    let config = AppConfig::load()?;
    let profile = config.cloud.gcp_profiles.get(&name);

    let service_account_path = profile
        .and_then(|p| p.service_account_key_path.clone())
        .map(std::path::PathBuf::from);

    let auth = GcpGkeAuth::new(service_account_path);

    match auth.authenticate().await {
        Ok(result) => {
            let expires = result.expires_at.map_or_else(
                || "unknown".to_string(),
                |t| t.format("%Y-%m-%d %H:%M:%S UTC").to_string(),
            );
            Ok(format!(
                "Authentication successful! Token expires: {expires}"
            ))
        }
        Err(e) => Ok(format!("Authentication failed: {e}")),
    }
}

// --- Azure profiles ---------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureProfileInfo {
    pub name: String,
    pub profile: AzureProfile,
}

#[tauri::command]
pub fn list_azure_profiles() -> Result<Vec<AzureProfileInfo>> {
    read_config(|config| {
        config
            .cloud
            .azure_profiles
            .iter()
            .map(|(name, profile)| AzureProfileInfo {
                name: name.clone(),
                profile: profile.clone(),
            })
            .collect()
    })
}

#[tauri::command]
pub fn save_azure_profile(name: String, profile: AzureProfile) -> Result<()> {
    with_config(|config| {
        config
            .cloud
            .azure_profiles
            .insert(name, profile.clean_empty_strings());
    })
}

#[tauri::command]
pub fn delete_azure_profile(name: String) -> Result<()> {
    with_config(|config| {
        config.cloud.azure_profiles.remove(&name);
        // Also remove any context bindings using this profile
        for binding in config.cloud.context_bindings.values_mut() {
            if binding.azure_profile.as_ref() == Some(&name) {
                binding.azure_profile = None;
            }
        }
    })
}

#[tauri::command]
pub async fn test_azure_profile(name: String) -> Result<String> {
    use crate::auth::AzureAksAuth;

    let config = AppConfig::load()?;
    let profile = config.cloud.azure_profiles.get(&name);

    let (use_cli_fallback, tenant_id) =
        profile.map_or((false, None), |p| (p.use_cli_fallback, p.tenant_id.clone()));

    let auth = AzureAksAuth::new(use_cli_fallback, tenant_id);

    match auth.authenticate().await {
        Ok(result) => {
            let expires = result.expires_at.map_or_else(
                || "unknown".to_string(),
                |t| t.format("%Y-%m-%d %H:%M:%S UTC").to_string(),
            );
            Ok(format!(
                "Authentication successful! Token expires: {expires}"
            ))
        }
        Err(e) => Ok(format!("Authentication failed: {e}")),
    }
}

// --- Context bindings -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBindingInfo {
    pub context_name: String,
    pub gcp_profile: Option<String>,
    pub azure_profile: Option<String>,
}

#[tauri::command]
pub fn list_context_bindings() -> Result<Vec<ContextBindingInfo>> {
    read_config(|config| {
        config
            .cloud
            .context_bindings
            .iter()
            .map(|(context_name, binding)| ContextBindingInfo {
                context_name: context_name.clone(),
                gcp_profile: binding.gcp_profile.clone(),
                azure_profile: binding.azure_profile.clone(),
            })
            .collect()
    })
}

#[tauri::command]
pub fn get_context_binding(context: String) -> Result<ContextBinding> {
    read_config(|config| {
        config
            .cloud
            .context_bindings
            .get(&context)
            .cloned()
            .unwrap_or_default()
    })
}

#[tauri::command]
pub fn save_context_binding(context: String, binding: ContextBinding) -> Result<()> {
    with_config(|config| {
        // If both profiles are None, remove the binding entirely
        if binding.gcp_profile.is_none() && binding.azure_profile.is_none() {
            config.cloud.context_bindings.remove(&context);
        } else {
            config.cloud.context_bindings.insert(context, binding);
        }
    })
}

#[tauri::command]
pub fn delete_context_binding(context: String) -> Result<()> {
    with_config(|config| {
        config.cloud.context_bindings.remove(&context);
    })
}

// --- CLI paths --------------------------------------------------------------

#[tauri::command]
pub fn get_cli_paths() -> Result<CliPathsConfig> {
    read_config(|config| config.cli_paths.clone())
}

#[tauri::command]
pub async fn save_cli_paths(cli_paths: CliPathsConfig) -> Result<()> {
    // Filter empty strings
    let cleaned = CliPathsConfig {
        helm_path: cli_paths.helm_path.filter(|s| !s.is_empty()),
        kubectl_path: cli_paths.kubectl_path.filter(|s| !s.is_empty()),
    };

    with_config(|config| {
        config.cli_paths = cleaned;
    })?;

    // So the managers pick up the new custom paths immediately.
    crate::commands::kubectl::reload_kubectl_manager().await;
    crate::commands::helm::reload_helm_manager().await;

    Ok(())
}

// --- Kubeconfig path override -----------------------------------------------

/// Return the persisted kubeconfig override path. `None` means "use
/// default lookup" (i.e. $KUBECONFIG or ~/.kube/config).
#[tauri::command]
pub fn get_kubeconfig_path() -> Result<Option<String>> {
    read_config(|config| {
        config
            .kubernetes
            .kubeconfig_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
    })
}

/// Every pinned kubeconfig path, in merge order.
///
/// Empty means nothing is pinned and the default lookup applies.
#[tauri::command]
pub fn get_kubeconfig_paths() -> Result<Vec<String>> {
    read_config(|config| {
        let paths = if config.kubernetes.kubeconfig_paths.is_empty() {
            config
                .kubernetes
                .kubeconfig_path
                .clone()
                .into_iter()
                .collect()
        } else {
            config.kubernetes.kubeconfig_paths.clone()
        };
        paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    })
}

/// Persist a kubeconfig override path. Validates the path resolves and
/// parses as a kubeconfig file (so the user can't save garbage that
/// would brick the next startup). Empty string clears the override.
#[tauri::command]
pub async fn set_kubeconfig_path(
    path: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<()> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return clear_kubeconfig_path(state).await;
    }
    set_kubeconfig_paths(vec![trimmed.to_string()], state).await
}

/// Pin these files, in this order, as the kubeconfig the app reads.
///
/// The whole list at once rather than one add and one remove: the files
/// merge, and merging depends on the order, so "the list is now this" is the
/// only statement that says what the app will read. It also keeps the check
/// honest — the new list is loaded before anything is written, so a file that
/// will not parse leaves the reader on the set they had rather than
/// half-applying. An empty list goes back to the default lookup.
#[tauri::command]
pub async fn set_kubeconfig_paths(
    paths: Vec<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<()> {
    let wanted: Vec<std::path::PathBuf> = paths
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(std::path::PathBuf::from)
        .collect();

    if wanted.is_empty() {
        return clear_kubeconfig_path(state).await;
    }

    // Validated through the loader the rest of the app reads clusters with,
    // so a rejection here is the rejection the cluster list would have hit.
    state
        .client_manager
        .load_kubeconfig_resolved(wanted.clone())
        .await
        .map_err(|e| crate::error::Error::Config(format!("Invalid kubeconfig path: {e}")))?;

    with_config(|config| {
        // The single field carries the first of them, for a build that has
        // never heard of the list.
        config.kubernetes.kubeconfig_path = wanted.first().cloned();
        config.kubernetes.kubeconfig_paths.clone_from(&wanted);
    })?;

    // Drop any cached clients / current context — they were bound to
    // the previous kubeconfig and would now point at the wrong cluster.
    state.client_manager.disconnect_all();
    state.set_current_context(None);

    Ok(())
}

/// Clear the kubeconfig override, reverting to default lookup.
#[tauri::command]
pub async fn clear_kubeconfig_path(state: tauri::State<'_, crate::state::AppState>) -> Result<()> {
    with_config(|config| {
        config.kubernetes.kubeconfig_path = None;
        config.kubernetes.kubeconfig_paths = Vec::new();
    })?;

    // Re-load using the now-cleared override (i.e. default lookup) so
    // subsequent list_contexts sees the right cluster set immediately.
    state
        .client_manager
        .load_kubeconfig_resolved(Vec::new())
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;
    state.client_manager.disconnect_all();
    state.set_current_context(None);

    Ok(())
}
