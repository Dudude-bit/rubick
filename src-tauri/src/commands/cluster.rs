//! Cluster management commands

use tauri::State;
use tokio::time::{timeout, Duration};

use crate::auth::prepare_kubeconfig_for_context;
use crate::client::{ClusterInfo, ContextInfo};
use crate::error::Result;
use crate::state::AppState;

/// The pinned kubeconfig files, in merge order.
///
/// Empty on a read failure — treated as "nothing pinned" — so a corrupted
/// config file does not lock somebody out of the default `~/.kube/config`
/// lookup entirely.
///
/// The list wins where there is one; `kubeconfig_path` is what a build
/// without several files writes, and is still read so that pinning a file
/// in such a build and then upgrading does not silently unpin it.
fn read_kubeconfig_overrides() -> Vec<std::path::PathBuf> {
    crate::commands::settings::helpers::read_config(|c| {
        pinned_files(
            &c.kubernetes.kubeconfig_paths,
            c.kubernetes.kubeconfig_path.as_ref(),
        )
    })
    .unwrap_or_default()
}

/// The two fields reconciled, as a rule rather than as a read of the disk.
///
/// The list wins where there is one. `kubeconfig_path` is what a build
/// without several files writes, and is still honoured so that pinning a
/// file in such a build and then upgrading does not silently unpin it.
fn pinned_files(
    paths: &[std::path::PathBuf],
    single: Option<&std::path::PathBuf>,
) -> Vec<std::path::PathBuf> {
    if paths.is_empty() {
        single.cloned().into_iter().collect()
    } else {
        paths.to_vec()
    }
}

/// List all available Kubernetes contexts
#[tauri::command]
pub async fn list_contexts(state: State<'_, AppState>) -> Result<Vec<ContextInfo>> {
    // Ensure kubeconfig is loaded
    state
        .client_manager
        .load_kubeconfig_resolved(read_kubeconfig_overrides())
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
        .load_kubeconfig_resolved(read_kubeconfig_overrides())
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;

    state
        .client_manager
        .get_current_context()
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))
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
            why: Some(crate::state::AuthOutcome::Superseded),
        });
    }

    // Reset any cached client/config for this context to ensure fresh auth
    state.client_manager.disconnect(&context);
    state.remove_session(&context);

    // Load kubeconfig if not already loaded
    state
        .client_manager
        .load_kubeconfig_resolved(read_kubeconfig_overrides())
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
        Duration::from_mins(2),
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
            why: Some(crate::state::AuthOutcome::SwitchedAway),
        });
    }

    state.client_manager.disconnect(&context);
    state.remove_session(&context);

    // Clear current context if it matches
    if state.get_current_context().as_ref() == Some(&context) {
        state.set_current_context(None);
    }

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
    /// The contexts this file is the source of, once several are merged.
    ///
    /// Empty where there is only one file — every context came from it and
    /// saying so on each row is noise — and empty for a name another file
    /// claimed first, which is the merge rule and worth being able to see.
    #[serde(default)]
    pub contexts: Vec<String>,
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

fn candidate(path: &std::path::Path, origin: &str) -> KubeconfigCandidate {
    KubeconfigCandidate {
        exists: path.exists(),
        path: path.to_string_lossy().into_owned(),
        origin: origin.to_string(),
        contexts: Vec::new(),
    }
}

/// Hand each candidate the contexts that were read from it.
///
/// Matched on the canonical path, because that is what the loader recorded
/// and what a symlinked `~/.kube/config` resolves to — comparing the typed
/// path would leave every row empty on exactly the setup where naming the
/// file matters most.
fn attach_contexts(
    candidates: &mut [KubeconfigCandidate],
    origins: &std::collections::HashMap<String, std::path::PathBuf>,
) {
    if origins.is_empty() {
        return;
    }
    for entry in candidates.iter_mut() {
        let canonical = std::path::Path::new(&entry.path)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(&entry.path));
        let mut names: Vec<String> = origins
            .iter()
            .filter(|(_, from)| **from == canonical)
            .map(|(context, _)| context.clone())
            .collect();
        names.sort();
        entry.contexts = names;
    }
}

/// Mirrors the lookup `load_kubeconfig_resolved` performs: a persisted
/// override wins outright, otherwise `$KUBECONFIG` (which kube-rs splits
/// on the platform's path separator and merges), otherwise the one
/// default path.
fn kubeconfig_candidates(
    overrides: Vec<std::path::PathBuf>,
    env: Option<&str>,
) -> Vec<KubeconfigCandidate> {
    if !overrides.is_empty() {
        return overrides
            .iter()
            .map(|path| candidate(path, "override"))
            .collect();
    }
    if let Some(value) = env.filter(|v| !v.is_empty()) {
        let separator = if cfg!(windows) { ';' } else { ':' };
        return value
            .split(separator)
            .filter(|entry| !entry.is_empty())
            .map(|entry| candidate(std::path::Path::new(entry), "env"))
            .collect();
    }
    let default = dirs::home_dir().map_or_else(
        || std::path::PathBuf::from("~/.kube/config"),
        |home| home.join(".kube").join("config"),
    );
    vec![candidate(&default, "default")]
}

/// Report the kubeconfig lookup and what it found.
#[tauri::command]
pub async fn get_kubeconfig_source(state: State<'_, AppState>) -> Result<KubeconfigSource> {
    let kubeconfig_env = std::env::var("KUBECONFIG").ok();
    let overrides = read_kubeconfig_overrides();
    let candidates = kubeconfig_candidates(overrides.clone(), kubeconfig_env.as_deref());

    // Load through the same path the rest of the app uses, so a failure
    // here is the failure the cluster list would have hit.
    let error = state
        .client_manager
        .load_kubeconfig_resolved(overrides)
        .await
        .err()
        .map(|e| e.to_string());

    let mut candidates = candidates;
    attach_contexts(
        &mut candidates,
        &state.client_manager.context_origins().await,
    );

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
    use super::{kubeconfig_candidates, pinned_files};

    #[test]
    fn env_kubeconfig_lists_every_file_it_would_merge() {
        let candidates = kubeconfig_candidates(
            Vec::new(),
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
        let candidates = kubeconfig_candidates(Vec::new(), None);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].origin, "default");
        assert!(candidates[0].path.ends_with("config"));
    }

    #[test]
    fn empty_kubeconfig_is_treated_as_unset() {
        assert_eq!(
            kubeconfig_candidates(Vec::new(), Some(""))[0].origin,
            "default"
        );
    }

    /// A pinned file is the only one that would be read, so listing what
    /// `$KUBECONFIG` names beside it would say the app looked somewhere it
    /// did not.
    #[test]
    fn an_override_is_the_only_candidate() {
        let candidates = kubeconfig_candidates(
            vec![std::path::PathBuf::from("/tmp/pinned")],
            Some("a.yaml"),
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].origin, "override");
    }

    /// A file pinned by a build that had never heard of the list is still
    /// read after upgrading. Ignoring the old field would silently unpin
    /// somebody's cluster the first time they ran a newer build.
    #[test]
    fn a_single_pinned_file_survives_the_upgrade() {
        let one = std::path::PathBuf::from("/tmp/pinned");
        assert_eq!(pinned_files(&[], Some(&one)), vec![one]);
    }

    /// And the list wins once there is one, whatever the old field still
    /// holds — it holds the first of them, so honouring it would read that
    /// file twice and the others not at all.
    #[test]
    fn the_list_wins_over_the_field_it_replaced() {
        let first = std::path::PathBuf::from("/tmp/work");
        let second = std::path::PathBuf::from("/tmp/home");
        assert_eq!(
            pinned_files(&[first.clone(), second.clone()], Some(&first)),
            vec![first, second]
        );
    }

    /// Neither set is the default lookup, which is not a path at all.
    #[test]
    fn nothing_pinned_is_an_empty_list() {
        assert!(pinned_files(&[], None).is_empty());
    }

    /// Several pinned files are all read, in the order they were pinned —
    /// which is what decides the merge.
    #[test]
    fn every_pinned_file_is_a_candidate_in_order() {
        let candidates = kubeconfig_candidates(
            vec![
                std::path::PathBuf::from("/tmp/work"),
                std::path::PathBuf::from("/tmp/home"),
            ],
            Some("ignored.yaml"),
        );
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].path, "/tmp/work");
        assert_eq!(candidates[1].path, "/tmp/home");
        assert!(candidates.iter().all(|c| c.origin == "override"));
    }
}
