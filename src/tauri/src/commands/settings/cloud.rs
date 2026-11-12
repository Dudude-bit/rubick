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
pub async fn list_gcp_profiles() -> Result<Vec<GcpProfileInfo>> {
    read_config(move |config| {
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
    .await
}

#[tauri::command]
pub async fn save_gcp_profile(name: String, profile: GcpProfile) -> Result<()> {
    with_config(move |config| {
        config
            .cloud
            .gcp_profiles
            .insert(name, profile.clean_empty_strings());
    })
    .await
}

#[tauri::command]
pub async fn delete_gcp_profile(name: String) -> Result<()> {
    with_config(move |config| {
        config.cloud.gcp_profiles.remove(&name);
        // Also remove any context bindings using this profile
        for binding in config.cloud.context_bindings.values_mut() {
            if binding.gcp_profile.as_ref() == Some(&name) {
                binding.gcp_profile = None;
            }
        }
    })
    .await
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
pub async fn list_azure_profiles() -> Result<Vec<AzureProfileInfo>> {
    read_config(move |config| {
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
    .await
}

#[tauri::command]
pub async fn save_azure_profile(name: String, profile: AzureProfile) -> Result<()> {
    with_config(move |config| {
        config
            .cloud
            .azure_profiles
            .insert(name, profile.clean_empty_strings());
    })
    .await
}

#[tauri::command]
pub async fn delete_azure_profile(name: String) -> Result<()> {
    with_config(move |config| {
        config.cloud.azure_profiles.remove(&name);
        // Also remove any context bindings using this profile
        for binding in config.cloud.context_bindings.values_mut() {
            if binding.azure_profile.as_ref() == Some(&name) {
                binding.azure_profile = None;
            }
        }
    })
    .await
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
pub async fn list_context_bindings() -> Result<Vec<ContextBindingInfo>> {
    read_config(move |config| {
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
    .await
}

#[tauri::command]
pub async fn get_context_binding(context: String) -> Result<ContextBinding> {
    read_config(move |config| {
        config
            .cloud
            .context_bindings
            .get(&context)
            .cloned()
            .unwrap_or_default()
    })
    .await
}

#[tauri::command]
pub async fn save_context_binding(context: String, binding: ContextBinding) -> Result<()> {
    with_config(move |config| {
        // If both profiles are None, remove the binding entirely
        if binding.gcp_profile.is_none() && binding.azure_profile.is_none() {
            config.cloud.context_bindings.remove(&context);
        } else {
            config.cloud.context_bindings.insert(context, binding);
        }
    })
    .await
}

#[tauri::command]
pub async fn delete_context_binding(context: String) -> Result<()> {
    with_config(move |config| {
        config.cloud.context_bindings.remove(&context);
    })
    .await
}

// --- CLI paths --------------------------------------------------------------

#[tauri::command]
pub async fn get_cli_paths() -> Result<CliPathsConfig> {
    read_config(move |config| config.cli_paths.clone()).await
}

#[tauri::command]
pub async fn save_cli_paths(cli_paths: CliPathsConfig) -> Result<()> {
    // Filter empty strings
    let cleaned = CliPathsConfig {
        helm_path: cli_paths.helm_path.filter(|s| !s.is_empty()),
        kubectl_path: cli_paths.kubectl_path.filter(|s| !s.is_empty()),
    };

    with_config(move |config| {
        config.cli_paths = cleaned;
    })
    .await?;

    // So the managers pick up the new custom paths immediately.
    crate::commands::kubectl::reload_kubectl_manager().await;
    crate::commands::helm::reload_helm_manager().await;

    Ok(())
}

// --- Kubeconfig path override -----------------------------------------------

/// Return the persisted kubeconfig override path. `None` means "use
/// default lookup" (i.e. $KUBECONFIG or ~/.kube/config).
#[tauri::command]
pub async fn get_kubeconfig_path() -> Result<Option<String>> {
    read_config(move |config| {
        config
            .kubernetes
            .kubeconfig_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
}

/// Every pinned kubeconfig path, in merge order.
///
/// Empty means nothing is pinned and the default lookup applies.
#[tauri::command]
pub async fn get_kubeconfig_paths() -> Result<Vec<String>> {
    read_config(move |config| {
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
    .await
}

/// Persist a kubeconfig override path. Validates the path resolves and
/// parses as a kubeconfig file (so the user can't save garbage that
/// would brick the next startup). Empty string clears the override.
#[tauri::command]
pub async fn set_kubeconfig_path(
    path: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<()> {
    set_kubeconfig_paths(vec![path], state).await
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

    repin(&state, wanted).await
}

/// The list the reader asked for, loaded and only then saved: an empty one
/// is the default lookup, and is checked like any other. Saved first, a
/// default lookup that found no file was refused on screen, with every
/// cluster still working, and in force after the next launch.
async fn checked_then_saved(
    manager: &crate::client::K8sClientManager,
    wanted: Vec<std::path::PathBuf>,
    save: impl std::future::Future<Output = Result<()>>,
) -> Result<()> {
    let pinned = !wanted.is_empty();
    // Through the loader the rest of the app reads clusters with, so a
    // rejection here is the rejection the cluster list would have hit.
    manager
        .load_kubeconfig_resolved(wanted)
        .await
        .map_err(|e| {
            crate::error::Error::Config(if pinned {
                format!("Invalid kubeconfig path: {e}")
            } else {
                e.to_string()
            })
        })?;
    save.await
}

async fn repin(state: &crate::state::AppState, wanted: Vec<std::path::PathBuf>) -> Result<()> {
    let saved = wanted.clone();
    checked_then_saved(
        &state.client_manager,
        wanted,
        with_config(move |config| {
            // The single field carries the first of them, for a build that
            // has never heard of the list.
            config.kubernetes.kubeconfig_path = saved.first().cloned();
            config.kubernetes.kubeconfig_paths = saved;
        }),
    )
    .await?;

    // Every session was bound to the previous kubeconfig and would now
    // point at the wrong cluster. The caller reconnects the one on screen.
    crate::commands::cluster::teardown_all(state);

    Ok(())
}

/// Clear the kubeconfig override, reverting to default lookup.
#[tauri::command]
pub async fn clear_kubeconfig_path(state: tauri::State<'_, crate::state::AppState>) -> Result<()> {
    repin(&state, Vec::new()).await
}

#[cfg(test)]
mod tests {
    use super::checked_then_saved;
    use crate::client::tests::KubeconfigEnv;
    use crate::client::K8sClientManager;
    use std::sync::atomic::{AtomicBool, Ordering};

    const GOOD: &str =
        "apiVersion: v1\nkind: Config\ncontexts:\n  - name: prod\n    context:\n      \
                        cluster: prod\n      user: prod\nclusters: []\nusers: []\n";

    /// "Use default lookup" with no default file wrote the cleared pin to
    /// `config.toml` and then failed: the toast said it could not, every
    /// cluster kept working, and the pin was gone after the next launch.
    /// Fails if a default lookup that finds no file is saved all the same.
    #[tokio::test]
    async fn a_default_lookup_that_finds_no_file_is_refused_before_anything_is_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pinned = dir.path().join("work.yaml");
        std::fs::write(&pinned, GOOD).expect("write");
        let manager = K8sClientManager::new();
        manager
            .load_kubeconfig_resolved(vec![pinned.clone()])
            .await
            .expect("the pinned file loads");

        let saved = AtomicBool::new(false);
        let env = KubeconfigEnv::set(dir.path().join("no-such-file.yaml")).await;
        let cleared = checked_then_saved(&manager, Vec::new(), async {
            saved.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
        drop(env);

        assert!(cleared.is_err(), "there is no default file to go back to");
        assert!(!saved.load(Ordering::SeqCst), "the pin was cleared on disk");
        assert_eq!(
            manager.kubeconfig_path().await,
            Some(pinned.canonicalize().expect("canonical")),
            "the app still lives on the file it had"
        );
    }

    /// The other half: a list that loads is the one that is saved.
    #[tokio::test]
    async fn a_default_lookup_that_loads_is_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let default = dir.path().join("config");
        std::fs::write(&default, GOOD).expect("write");
        let manager = K8sClientManager::new();

        let saved = AtomicBool::new(false);
        let env = KubeconfigEnv::set(&default).await;
        let cleared = checked_then_saved(&manager, Vec::new(), async {
            saved.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
        drop(env);

        cleared.expect("the default file loads");
        assert!(saved.load(Ordering::SeqCst));
    }
}
