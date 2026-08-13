//! Cluster management commands

use tauri::State;
use tokio::time::{timeout, Duration};

use crate::auth::prepare_kubeconfig_for_context;
use crate::client::{ClusterInfo, ContextInfo};
use crate::error::Result;
use crate::state::AppState;

/// Read the persisted kubeconfig override path from AppConfig. Returns
/// None on read failure (treated as "no override") so a corrupted
/// config file doesn't lock the user out of the default `~/.kube/config`
/// path entirely.
fn read_kubeconfig_override() -> Option<std::path::PathBuf> {
    crate::commands::settings::helpers::read_config(|c| c.kubernetes.kubeconfig_path.clone())
        .ok()
        .flatten()
}

/// List all available Kubernetes contexts
#[tauri::command]
pub async fn list_contexts(state: State<'_, AppState>) -> Result<Vec<ContextInfo>> {
    // Ensure kubeconfig is loaded
    state
        .client_manager
        .load_kubeconfig_resolved(read_kubeconfig_override())
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;

    state
        .client_manager
        .list_contexts()
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))
}

/// Get the current active context
#[tauri::command]
pub async fn get_current_context(state: State<'_, AppState>) -> Result<Option<String>> {
    state
        .client_manager
        .load_kubeconfig_resolved(read_kubeconfig_override())
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;

    state
        .client_manager
        .get_current_context()
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))
}

/// Switch to a different context
#[tauri::command]
pub async fn switch_context(context: String, state: State<'_, AppState>) -> Result<()> {
    // Disconnect from current context if connected
    if let Some(current) = state.get_current_context() {
        state.client_manager.disconnect(&current);
    }

    // Load kubeconfig if not already loaded
    state
        .client_manager
        .load_kubeconfig_resolved(read_kubeconfig_override())
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;

    // Connect to new context
    state
        .client_manager
        .connect(&context)
        .await
        .map_err(|e| crate::error::Error::Connection(e.to_string()))?;

    // Update state
    state.set_current_context(Some(context.clone()));
    state.create_session(&context);

    // Emit connection event
    state.emit(crate::state::AppEvent::ConnectionStatusChanged {
        context: context.clone(),
        connected: true,
    });

    tracing::info!("Switched to context: {}", context);
    Ok(())
}

/// Connect to a cluster by context name
#[tauri::command]
pub async fn connect_cluster(context: String, state: State<'_, AppState>) -> Result<ClusterInfo> {
    let generation = state.next_connect_generation();
    let cancelled_sessions = state.cancel_auth_sessions_for_context(&context);
    for session_id in cancelled_sessions {
        state.emit(crate::state::AppEvent::AuthFlowCancelled {
            session_id,
            context: context.clone(),
            message: Some("Authentication superseded by a new attempt.".to_string()),
        });
    }

    // Reset any cached client/config for this context to ensure fresh auth
    state.client_manager.disconnect(&context);
    state.remove_session(&context);

    // Load kubeconfig if not already loaded
    state
        .client_manager
        .load_kubeconfig_resolved(read_kubeconfig_override())
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;

    let kubeconfig = state
        .client_manager
        .kubeconfig_clone()
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;
    let prepared = prepare_kubeconfig_for_context(&state, kubeconfig, &context)
        .await
        .map_err(|e| {
            crate::error::Error::Auth(crate::error::AuthError::Kubeconfig(e.to_string()))
        })?;
    state
        .client_manager
        .set_credential_deadline(&context, prepared.expires_at);
    state
        .client_manager
        .connect_with_kubeconfig(&context, prepared.kubeconfig)
        .await
        .map_err(|e| crate::error::Error::Connection(e.to_string()))?;

    // Test connection and get cluster info (timeout to avoid hanging auth flows)
    let info = match timeout(
        Duration::from_secs(120),
        state.client_manager.test_connection(&context),
    )
    .await
    {
        Ok(Ok(info)) => info,
        Ok(Err(e)) => {
            state.client_manager.disconnect(&context);
            state.remove_session(&context);
            return Err(crate::error::Error::Connection(e.to_string()));
        }
        Err(_) => {
            state.client_manager.disconnect(&context);
            state.remove_session(&context);
            return Err(crate::error::Error::Timeout(
                "Connection timed out. Please retry the authentication flow.".to_string(),
            ));
        }
    };

    if !state.is_latest_connect_generation(generation) {
        state.client_manager.disconnect(&context);
        state.remove_session(&context);
        return Err(crate::error::Error::Connection(
            "Connection superseded by a newer attempt.".to_string(),
        ));
    }

    // Update state
    state.set_current_context(Some(context.clone()));
    state.create_session(&context);

    // Emit connection event
    state.emit(crate::state::AppEvent::ConnectionStatusChanged {
        context: context.clone(),
        connected: true,
    });

    Ok(info)
}

/// Disconnect from a cluster
#[tauri::command]
pub fn disconnect_cluster(context: String, state: State<'_, AppState>) -> Result<()> {
    // Cancel any in-flight auth sessions for this context. Without this
    // a sequence like `gke (auth modal open) → minikube (no auth needed)`
    // leaves the gke modal stuck because nothing emits AuthFlowCancelled
    // for the orphaned session — clusterStore.connect issues
    // `disconnect_cluster(previous)` precisely here, and the modal only
    // closes on cancel/completed events.
    let cancelled_sessions = state.cancel_auth_sessions_for_context(&context);
    for session_id in cancelled_sessions {
        state.emit(crate::state::AppEvent::AuthFlowCancelled {
            session_id,
            context: context.clone(),
            message: Some("Authentication cancelled — switched away.".to_string()),
        });
    }

    state.client_manager.disconnect(&context);
    state.remove_session(&context);

    // Clear current context if it matches
    if state.get_current_context().as_ref() == Some(&context) {
        state.set_current_context(None);
    }

    // Emit connection event
    state.emit(crate::state::AppEvent::ConnectionStatusChanged {
        context: context.clone(),
        connected: false,
    });

    tracing::info!("Disconnected from cluster: {}", context);
    Ok(())
}

/// Get cluster information
#[tauri::command]
pub async fn get_cluster_info(context: String, state: State<'_, AppState>) -> Result<ClusterInfo> {
    state
        .client_manager
        .test_connection(&context)
        .await
        .map_err(|e| crate::error::Error::Connection(e.to_string()))
}

// ============================================================================
// Where the cluster list came from
// ============================================================================

/// One file the app would read a kubeconfig from, and whether it is there.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KubeconfigCandidate {
    pub path: String,
    pub exists: bool,
    /// Why this path is in the list: `override`, `env` or `default`.
    pub origin: String,
}

/// What the file that was read actually held. Absent when nothing parsed.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KubeconfigCounts {
    pub contexts: usize,
    pub clusters: usize,
    pub users: usize,
}

/// Where the cluster list came from, for the screen that has none.
///
/// "Why is my cluster not listed" is almost always the wrong file, so the
/// answer has to be the paths themselves rather than a sentence about
/// where the app usually looks.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KubeconfigSource {
    /// Every path that would be read, in the order it would be read.
    pub candidates: Vec<KubeconfigCandidate>,
    /// `$KUBECONFIG` exactly as this process sees it; `None` when unset.
    pub kubeconfig_env: Option<String>,
    pub counts: Option<KubeconfigCounts>,
    /// The reader's own message when the read failed.
    pub error: Option<String>,
}

fn candidate(path: std::path::PathBuf, origin: &str) -> KubeconfigCandidate {
    KubeconfigCandidate {
        exists: path.exists(),
        path: path.to_string_lossy().into_owned(),
        origin: origin.to_string(),
    }
}

/// Mirrors the lookup `load_kubeconfig_resolved` performs: a persisted
/// override wins outright, otherwise `$KUBECONFIG` (which kube-rs splits
/// on the platform's path separator and merges), otherwise the one
/// default path.
fn kubeconfig_candidates(
    override_path: Option<std::path::PathBuf>,
    env: Option<&str>,
) -> Vec<KubeconfigCandidate> {
    if let Some(path) = override_path {
        return vec![candidate(path, "override")];
    }
    if let Some(value) = env.filter(|v| !v.is_empty()) {
        let separator = if cfg!(windows) { ';' } else { ':' };
        return value
            .split(separator)
            .filter(|entry| !entry.is_empty())
            .map(|entry| candidate(std::path::PathBuf::from(entry), "env"))
            .collect();
    }
    let default = dirs::home_dir()
        .map(|home| home.join(".kube").join("config"))
        .unwrap_or_else(|| std::path::PathBuf::from("~/.kube/config"));
    vec![candidate(default, "default")]
}

/// Report the kubeconfig lookup and what it found.
#[tauri::command]
pub async fn get_kubeconfig_source(state: State<'_, AppState>) -> Result<KubeconfigSource> {
    let kubeconfig_env = std::env::var("KUBECONFIG").ok();
    let override_path = read_kubeconfig_override();
    let candidates = kubeconfig_candidates(override_path.clone(), kubeconfig_env.as_deref());

    // Load through the same path the rest of the app uses, so a failure
    // here is the failure the cluster list would have hit.
    let error = state
        .client_manager
        .load_kubeconfig_resolved(override_path)
        .await
        .err()
        .map(|e| e.to_string());

    let counts = match state.client_manager.kubeconfig_clone().await {
        Ok(kubeconfig) => Some(KubeconfigCounts {
            contexts: kubeconfig.contexts.len(),
            clusters: kubeconfig.clusters.len(),
            users: kubeconfig.auth_infos.len(),
        }),
        Err(_) => None,
    };

    Ok(KubeconfigSource {
        candidates,
        kubeconfig_env,
        counts,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::kubeconfig_candidates;

    #[test]
    fn env_kubeconfig_lists_every_file_it_would_merge() {
        let candidates = kubeconfig_candidates(
            None,
            Some(if cfg!(windows) {
                "a.yaml;b.yaml"
            } else {
                "a.yaml:b.yaml"
            }),
        );
        assert_eq!(candidates.len(), 2);
        assert!(candidates.iter().all(|c| c.origin == "env"));
        assert_eq!(candidates[0].path, "a.yaml");
    }

    #[test]
    fn unset_kubeconfig_falls_back_to_the_one_default_path() {
        let candidates = kubeconfig_candidates(None, None);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].origin, "default");
        assert!(candidates[0].path.ends_with("config"));
    }

    #[test]
    fn empty_kubeconfig_is_treated_as_unset() {
        assert_eq!(kubeconfig_candidates(None, Some(""))[0].origin, "default");
    }

    /// An override is the only file that would be read, so listing the
    /// default path beside it would say the app looked somewhere it did not.
    #[test]
    fn an_override_is_the_only_candidate() {
        let candidates = kubeconfig_candidates(
            Some(std::path::PathBuf::from("/tmp/pinned")),
            Some("a.yaml"),
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].origin, "override");
    }
}
