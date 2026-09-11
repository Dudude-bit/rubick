//! Cluster management commands

use tauri::State;
use tokio::time::{timeout, Duration};

use crate::auth::prepare_kubeconfig_for_context;
use crate::client::{
    ClusterInfo, ConnectAttempt, ContextInfo, KubectlProxy, PathOutcome, ProxyOutcome,
};
use crate::error::{Error, Result};
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
    state.overview_cache.forget(&context);
    state.remove_session(&context);

    let overrides = read_kubeconfig_overrides();
    // Load kubeconfig if not already loaded
    state
        .client_manager
        .load_kubeconfig_resolved(overrides.clone())
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;

    let info = match connect_direct(&state, &context).await {
        Ok(info) => {
            state.client_manager.record_attempt(ConnectAttempt {
                context: context.clone(),
                at: chrono::Utc::now().to_rfc3339(),
                direct: PathOutcome::Ok,
                proxy: ProxyOutcome::NotTried,
            });
            info
        }
        Err(direct) => {
            state.client_manager.disconnect(&context);
            state.remove_session(&context);
            let mut attempt = ConnectAttempt {
                context: context.clone(),
                at: chrono::Utc::now().to_rfc3339(),
                direct: PathOutcome::Failed {
                    error: direct.to_string(),
                },
                proxy: ProxyOutcome::NotTried,
            };
            if !proxy_could_help(&direct) {
                state.client_manager.record_attempt(attempt);
                return Err(direct);
            }
            let Some(kubectl) = crate::commands::binaries::locate_on_user_path("kubectl") else {
                attempt.proxy = ProxyOutcome::NoKubectl;
                state.client_manager.record_attempt(attempt);
                return Err(direct);
            };
            match connect_through_proxy(&state, &context, &kubectl, &overrides).await {
                Ok((info, port)) => {
                    attempt.proxy = ProxyOutcome::Ok { port, kubectl };
                    state.client_manager.record_attempt(attempt);
                    info
                }
                Err(failure) => {
                    state.client_manager.disconnect(&context);
                    state.remove_session(&context);
                    attempt.proxy = ProxyOutcome::Failed {
                        error: failure.error,
                        stdout: failure.stdout,
                        stderr: failure.stderr,
                        kubectl,
                    };
                    state.client_manager.record_attempt(attempt);
                    // The first failure is the one to read; the proxy's is
                    // in the attempt record, one click away.
                    return Err(direct);
                }
            }
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

/// The app's own way in: prepare credentials, build a client, ask `/version`.
async fn connect_direct(state: &AppState, context: &str) -> Result<ClusterInfo> {
    let kubeconfig = state
        .client_manager
        .kubeconfig_clone()
        .await
        .map_err(|e| Error::Config(e.to_string()))?;
    let prepared = prepare_kubeconfig_for_context(state, kubeconfig, context)
        .await
        .map_err(prepared_failure)?;
    state
        .client_manager
        .set_credential_deadline(context, prepared.expires_at);
    state
        .client_manager
        .connect_with_kubeconfig(context, prepared.kubeconfig)
        .await
        .map_err(|e| Error::Connection(e.to_string()))?;
    probe(state, context).await
}

/// Through `kubectl proxy`: kubectl runs the plugin and holds the token.
async fn connect_through_proxy(
    state: &AppState,
    context: &str,
    kubectl: &str,
    kubeconfig: &[std::path::PathBuf],
) -> std::result::Result<(ClusterInfo, u16), crate::client::ProxyFailure> {
    let proxy = KubectlProxy::start(kubectl, context, kubeconfig).await?;
    let port = proxy.port;
    let stderr = proxy.stderr();
    state
        .client_manager
        .connect_through_proxy(context, proxy)
        .map_err(|e| crate::client::ProxyFailure {
            error: e.to_string(),
            stdout: String::new(),
            stderr: stderr.clone(),
        })?;
    // No deadline: kubectl renews what it holds, and the app never sees it.
    state.client_manager.set_credential_deadline(context, None);
    let info = probe(state, context)
        .await
        .map_err(|e| crate::client::ProxyFailure {
            error: e.to_string(),
            stdout: String::new(),
            stderr,
        })?;
    Ok((info, port))
}

/// `/version`, with a ceiling so an auth flow nobody finishes does not hang.
async fn probe(state: &AppState, context: &str) -> Result<ClusterInfo> {
    match timeout(
        Duration::from_mins(2),
        state.client_manager.test_connection(context),
    )
    .await
    {
        Ok(Ok(info)) => Ok(info),
        Ok(Err(e)) => Err(Error::Connection(e.to_string())),
        Err(_) => Err(Error::Timeout(
            "Connection timed out. Please retry the authentication flow.".to_string(),
        )),
    }
}

/// A failure from preparing credentials, filed the way the connect flow reads
/// it back.
///
/// A timeout keeps its own variant. It has to: `proxy_could_help` tells a
/// timeout apart from an auth failure by the variant, and flattening every
/// error into `Error::Auth` turned a timed-out login (exec's 30-minute
/// ceiling, OIDC's 3-minute redirect wait) into one the proxy would retry —
/// popping a fresh browser at a person who just let one lapse. Cancellation
/// still rides through as `Error::Auth`; its word survives in the string,
/// which is how `proxy_could_help` already recognises it.
fn prepared_failure(error: Error) -> Error {
    match error {
        Error::Timeout(_) => error,
        other => Error::Auth(crate::error::AuthError::Kubeconfig(other.to_string())),
    }
}

/// Whether a failure of the app's own path is one kubectl might get past.
///
/// A person who cancelled the login did not ask for a second one; a flow
/// still waiting at the two-minute mark would wait at kubectl's too. Every
/// other failure is worth the try: the proxy costs a second, and "could not
/// tell" is the more expensive answer.
pub(crate) fn proxy_could_help(direct: &Error) -> bool {
    match direct {
        Error::Timeout(_) => false,
        Error::Auth(auth) => !auth.to_string().to_lowercase().contains("cancel"),
        _ => true,
    }
}

/// The last attempt at a context, both ways, for the front door's hint.
#[tauri::command]
#[must_use]
pub fn connection_attempt(context: String, state: State<'_, AppState>) -> Option<ConnectAttempt> {
    state.client_manager.attempt_for(&context)
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
mod proxy_tests {
    use super::{prepared_failure, proxy_could_help};
    use crate::error::{AuthError, Error};

    /// The regression: the connect flow used to flatten a timed-out login
    /// into `Error::Auth`, and `proxy_could_help` tells a timeout apart by
    /// its variant — so a login that timed out got relaunched through
    /// kubectl proxy, exactly what a timeout must never do. The variant has
    /// to survive the filing.
    #[test]
    fn a_timed_out_login_keeps_its_variant_and_is_not_retried() {
        let filed = prepared_failure(Error::Timeout("Authentication timed out".into()));
        assert!(matches!(filed, Error::Timeout(_)));
        assert!(!proxy_could_help(&filed));
    }

    /// Cancellation is filed as an auth error, but keeps its word — which is
    /// how it is still recognised as not-worth-retrying.
    #[test]
    fn a_cancelled_login_files_as_auth_and_is_still_not_retried() {
        let filed = prepared_failure(Error::Auth(AuthError::Oidc(
            "Authentication cancelled".into(),
        )));
        assert!(matches!(filed, Error::Auth(_)));
        assert!(!proxy_could_help(&filed));
    }

    /// A broken plugin is filed as auth and is worth kubectl's try.
    #[test]
    fn a_broken_plugin_files_as_auth_and_is_retried() {
        let filed = prepared_failure(Error::Connection("exec plugin not found".into()));
        assert!(proxy_could_help(&filed));
    }

    /// A cancelled login turning into a `kubectl proxy` login is the app
    /// answering "no" with "are you sure".
    #[test]
    fn a_cancelled_login_is_not_retried_through_kubectl() {
        let cancelled = Error::Auth(AuthError::Kubeconfig("Authentication cancelled".into()));
        assert!(!proxy_could_help(&cancelled));
    }

    #[test]
    fn a_rejected_token_or_a_broken_plugin_is() {
        assert!(proxy_could_help(&Error::Connection(
            "Failed to get server version: Unauthorized".into()
        )));
        assert!(proxy_could_help(&Error::Auth(AuthError::Kubeconfig(
            "exec plugin kubectl-oidc_login not found".into()
        ))));
        assert!(!proxy_could_help(&Error::Timeout("2 minutes".into())));
    }
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
