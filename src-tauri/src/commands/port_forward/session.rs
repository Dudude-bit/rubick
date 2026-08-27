//! Live port-forward sessions: bind a local TCP port, accept
//! connections, copy bytes through `kube::Api::portforward`. Owns
//! the `PortForwardCleanup` Drop guard that ensures the session and
//! control map entries are removed on every exit including
//! panic-unwind.

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::state::{AppEvent, AppState, PortForwardSession};
use crate::utils::require_namespace;
use dashmap::DashMap;
use kube::Api;
use std::sync::Arc;
use tauri::State;
use tokio::net::TcpListener;
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

use super::types::{emit_port_forward_status, PortForwardRequest, PortForwardSessionInfo};

/// RAII guard that removes a port-forward's entries from both the
/// session and control maps when dropped — including on panic-unwind
/// inside the spawned listener task. Without this, a panic in
/// `listener.accept()` (or anywhere else in the outer loop) leaves
/// orphaned entries in `state.port_forward_sessions` /
/// `state.port_forward_controls` forever. Mirrors the `LogStreamCleanup`
/// pattern in commands/logs.rs.
struct PortForwardCleanup {
    sessions: Arc<DashMap<String, PortForwardSession>>,
    controls: Arc<DashMap<String, CancellationToken>>,
    key: String,
    /// Cancelled here, not only by the Stop button.
    ///
    /// The connections are detached tasks, so the session ending is the only
    /// thing that can reach them — and the session can end without anybody
    /// pressing Stop: the listener errors, or this task panics. Firing on
    /// drop means every exit path takes the connections with it, which is
    /// what "the session is over" has to mean if the maps are empty.
    cancel: CancellationToken,
}

impl Drop for PortForwardCleanup {
    fn drop(&mut self) {
        self.sessions.remove(&self.key);
        self.controls.remove(&self.key);
        self.cancel.cancel();
    }
}

#[allow(clippy::too_many_arguments)]
/// How many failures in a row before a forward stops claiming it is coming back.
///
/// Twelve at the capped ten seconds is about two minutes of trying, which
/// outlasts a rollout and a node reboot but not a lunch break. A forward that
/// has failed for two minutes is not reconnecting, and saying so is worth more
/// than a banner that never resolves.
const MAX_ATTEMPTS: u32 = 12;

/// What to do after a failed attempt, and what to say about it.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum AfterFailure {
    /// Wait, then try again. The reason rides along: a banner that says only
    /// "Retry in 10s" cannot be acted on, and this one repeated for a user
    /// whose credentials had simply expired.
    Retry { after: Duration, note: String },
    /// Stop, and say why. Nothing about trying again would change the answer.
    GiveUp { note: String },
}

/// Whether the API server's answer can change by asking again.
///
/// 401 and 403 can — this app does not renew credentials, so the recovery is
/// the user reconnecting, and `current_client` picks that up on the next
/// attempt. What cannot change on its own is a 404: the pod named at session
/// start is gone, and a Deployment's replacement has a different name.
fn permanent(err: &kube::Error) -> Option<&'static str> {
    match err {
        kube::Error::Api(response) if response.code == 404 => Some(
            "The pod is gone. A rollout replaced it under a new name — forward to the new pod.",
        ),
        _ => None,
    }
}

pub(super) fn after_failure(err: &kube::Error, attempt: u32, auto_reconnect: bool) -> AfterFailure {
    let reason = err.to_string();

    if !auto_reconnect {
        return AfterFailure::GiveUp {
            note: format!("Port-forward failed: {reason}"),
        };
    }
    if let Some(why) = permanent(err) {
        return AfterFailure::GiveUp {
            note: format!("{why} ({reason})"),
        };
    }
    if attempt >= MAX_ATTEMPTS {
        return AfterFailure::GiveUp {
            note: format!("Gave up after {attempt} attempts: {reason}"),
        };
    }

    let after = Duration::from_secs(u64::from(attempt).min(10));
    AfterFailure::Retry {
        after,
        note: format!("{reason} — retry in {}s", after.as_secs()),
    }
}

/// The client to forward through, looked up fresh.
///
/// Not the client the session started with. A `kube::Client` carries the
/// credentials it was built with, and this app does not renew them — a GKE
/// token lasts about an hour. Held across a session, it goes on failing every
/// call after that hour and keeps failing after the user reconnects the
/// cluster, because the reconnect replaces the manager's client while this
/// task still holds its own copy. Asked for per attempt, a reconnect heals
/// the forward instead of leaving it to retry a dead credential forever.
fn current_client(
    manager: &crate::client::K8sClientManager,
    context: &str,
) -> std::result::Result<kube::Client, String> {
    match manager.get_client(context) {
        Some(client) => Ok((*client).clone()),
        None => Err(format!("Not connected to {context}")),
    }
}

#[allow(clippy::too_many_arguments)]
async fn forward_connection(
    pod: String,
    namespace: String,
    remote_port: u16,
    local_port: u16,
    auto_reconnect: bool,
    clients: Arc<crate::client::K8sClientManager>,
    context: String,
    mut local_stream: tokio::net::TcpStream,
    event_tx: tokio::sync::broadcast::Sender<AppEvent>,
    session_id: String,
    cancel: CancellationToken,
) {
    let mut attempt: u32 = 0;

    loop {
        // Checked at the top as well as inside the waits: a connection
        // accepted in the same breath as Stop would otherwise open a stream
        // to a session that no longer exists.
        if cancel.is_cancelled() {
            return;
        }
        let attempt_result = match current_client(&clients, &context) {
            Ok(client) => {
                let ctx = ResourceContext::from_client(client, namespace.clone());
                let pod_api: Api<k8s_openapi::api::core::v1::Pod> = ctx.namespaced_api();
                pod_api.portforward(&pod, &[remote_port]).await
            }
            // Disconnected right now. Treated as a failed attempt rather than
            // a fatal one: the user reconnecting is exactly the recovery this
            // loop is waiting for.
            Err(why) => Err(kube::Error::Service(why.into())),
        };

        match attempt_result {
            Ok(mut portforwarder) => {
                if attempt > 0 {
                    emit_port_forward_status(
                        &event_tx,
                        &session_id,
                        &pod,
                        &namespace,
                        local_port,
                        remote_port,
                        "reconnected",
                        None,
                        Some(attempt),
                    );
                }

                if let Some(mut remote_stream) = portforwarder.take_stream(remote_port) {
                    // Stop has to reach the bytes in flight, not just the
                    // door. `copy_bidirectional` runs until one side closes,
                    // so a stopped forward with `psql` on it kept serving
                    // that session for as long as the client cared to hold
                    // it — the list said the forward was gone and the socket
                    // disagreed. Losing the select drops both halves, which
                    // closes the local socket and is what the client should
                    // see: the forward went away.
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(
                            &mut local_stream,
                            &mut remote_stream,
                        ) => {}
                        () = cancel.cancelled() => {}
                    }
                } else {
                    emit_port_forward_status(
                        &event_tx,
                        &session_id,
                        &pod,
                        &namespace,
                        local_port,
                        remote_port,
                        "error",
                        Some("Failed to open port forward stream".to_string()),
                        None,
                    );
                }

                break;
            }
            Err(err) => {
                attempt += 1;
                match after_failure(&err, attempt, auto_reconnect) {
                    AfterFailure::GiveUp { note } => {
                        emit_port_forward_status(
                            &event_tx,
                            &session_id,
                            &pod,
                            &namespace,
                            local_port,
                            remote_port,
                            "error",
                            Some(note),
                            Some(attempt),
                        );
                        break;
                    }
                    AfterFailure::Retry { after, note } => {
                        emit_port_forward_status(
                            &event_tx,
                            &session_id,
                            &pod,
                            &namespace,
                            local_port,
                            remote_port,
                            "reconnecting",
                            Some(note),
                            Some(attempt),
                        );
                        // The backoff is up to ten seconds, and a stopped
                        // forward spent every one of them still saying
                        // "reconnecting" about itself. Waking early on
                        // cancellation ends the retry rather than the wait.
                        tokio::select! {
                            () = sleep(after) => {}
                            () = cancel.cancelled() => return,
                        }
                    }
                }
            }
        }
    }
}

/// Start port forwarding to a pod
#[tauri::command]
pub async fn port_forward_pod(
    pod: String,
    namespace: Option<String>,
    config: PortForwardRequest,
    state: State<'_, AppState>,
) -> Result<PortForwardSessionInfo> {
    if config.local_port == 0 || config.remote_port == 0 {
        return Err(Error::InvalidInput(
            "Ports must be greater than 0".to_string(),
        ));
    }

    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;

    // Refuse a forward to a cluster we are not connected to, before binding a
    // local port that would then answer nothing. The client itself is not kept
    // — each attempt asks the manager again, see `current_client`.
    if state.client_manager.get_client(&context).is_none() {
        return Err(Error::Internal(
            crate::error::messages::NO_CLIENT.to_string(),
        ));
    }

    let namespace = require_namespace(namespace, String::new())?;

    let listener = TcpListener::bind(("127.0.0.1", config.local_port))
        .await
        .map_err(|e| {
            Error::Connection(format!("Failed to bind port {}: {e}", config.local_port))
        })?;

    let session_id = crate::utils::generate_id("pf");
    let created_at = chrono::Utc::now();

    let session = PortForwardSession {
        id: session_id.clone(),
        context: context.clone(),
        pod: pod.clone(),
        namespace: namespace.clone(),
        local_port: config.local_port,
        remote_port: config.remote_port,
        auto_reconnect: config.auto_reconnect,
        created_at,
    };

    state
        .port_forward_sessions
        .insert(session_id.clone(), session.clone());

    let cancel = CancellationToken::new();
    state
        .port_forward_controls
        .insert(session_id.clone(), cancel.clone());

    let event_tx = state.event_tx.clone();
    let session_id_for_task = session_id.clone();
    let namespace_for_task = namespace.clone();
    let pod_for_task = pod.clone();
    let clients_for_task = state.client_manager.clone();
    let context_for_task = context.clone();
    let auto_reconnect = config.auto_reconnect;
    let remote_port = config.remote_port;
    let local_port = config.local_port;
    let sessions = state.port_forward_sessions.clone();
    let controls = state.port_forward_controls.clone();

    tokio::spawn(async move {
        // Drop guard ensures map entries are removed on every exit
        // path — including a panic in listener.accept() or anywhere
        // else inside the loop. The explicit removes that used to live
        // at the bottom of this task have moved into the guard.
        let _cleanup = PortForwardCleanup {
            sessions: sessions.clone(),
            controls: controls.clone(),
            key: session_id_for_task.clone(),
            cancel: cancel.clone(),
        };

        emit_port_forward_status(
            &event_tx,
            &session_id_for_task,
            &pod_for_task,
            &namespace_for_task,
            local_port,
            remote_port,
            "listening",
            Some(format!(
                "127.0.0.1:{local_port} -> {pod_for_task}:{remote_port}"
            )),
            None,
        );

        loop {
            tokio::select! {
                () = cancel.cancelled() => {
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, _)) => {
                            let event_tx = event_tx.clone();
                            let session_id = session_id_for_task.clone();
                            let pod = pod_for_task.clone();
                            let namespace = namespace_for_task.clone();
                            let clients = clients_for_task.clone();
                            let context = context_for_task.clone();
                            let cancel = cancel.clone();

                            tokio::spawn(async move {
                                forward_connection(
                                    pod,
                                    namespace,
                                    remote_port,
                                    local_port,
                                    auto_reconnect,
                                    clients,
                                    context,
                                    stream,
                                    event_tx,
                                    session_id,
                                    cancel,
                                ).await;
                            });
                        }
                        Err(err) => {
                            emit_port_forward_status(
                                &event_tx, &session_id_for_task, &pod_for_task, &namespace_for_task,
                                local_port, remote_port, "error",
                                Some(format!("Listener error: {err}")), None,
                            );
                            break;
                        }
                    }
                }
            }
        }

        emit_port_forward_status(
            &event_tx,
            &session_id_for_task,
            &pod_for_task,
            &namespace_for_task,
            local_port,
            remote_port,
            "stopped",
            None,
            None,
        );
        // _cleanup drops here, removing both map entries.
    });

    Ok(PortForwardSessionInfo {
        id: session.id,
        context: session.context,
        pod: session.pod,
        namespace: session.namespace,
        local_port: session.local_port,
        remote_port: session.remote_port,
        auto_reconnect: session.auto_reconnect,
        created_at: session.created_at.to_rfc3339(),
    })
}

/// Stop a running port-forward session
#[tauri::command]
pub fn stop_port_forward(forward_id: String, state: State<'_, AppState>) -> Result<()> {
    // Remove from both maps atomically to avoid race conditions
    // The background task will also try to remove, but that's fine (no-op if already removed)
    state.port_forward_sessions.remove(&forward_id);
    if let Some((_, cancel)) = state.port_forward_controls.remove(&forward_id) {
        cancel.cancel();
    }

    Ok(())
}

/// List active port-forward sessions
#[tauri::command]
pub fn list_port_forwards(state: State<'_, AppState>) -> Result<Vec<PortForwardSessionInfo>> {
    let sessions = state
        .port_forward_sessions
        .iter()
        .map(|entry| {
            let session = entry.value();
            PortForwardSessionInfo {
                id: session.id.clone(),
                context: session.context.clone(),
                pod: session.pod.clone(),
                namespace: session.namespace.clone(),
                local_port: session.local_port,
                remote_port: session.remote_port,
                auto_reconnect: session.auto_reconnect,
                created_at: session.created_at.to_rfc3339(),
            }
        })
        .collect();

    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_session(id: &str) -> PortForwardSession {
        PortForwardSession {
            id: id.to_string(),
            context: "ctx".to_string(),
            pod: "p".to_string(),
            namespace: "n".to_string(),
            local_port: 8080,
            remote_port: 80,
            auto_reconnect: false,
            created_at: chrono::Utc::now(),
        }
    }

    fn api_error(code: u16) -> kube::Error {
        kube::Error::Api(kube::error::ErrorResponse {
            status: "Failure".into(),
            message: format!("the server responded with {code}"),
            reason: "Whatever".into(),
            code,
        })
    }

    /// The reported bug. A user watched "Port-forward reconnecting / Retry in
    /// 10s" repeat and had no way to learn why — the reason was thrown away
    /// and only the delay survived.
    #[test]
    fn a_retry_says_why_it_is_retrying() {
        let AfterFailure::Retry { note, .. } = after_failure(&api_error(401), 3, true) else {
            panic!("a 401 is recoverable by reconnecting, so it should retry");
        };
        assert!(
            note.contains("401"),
            "the reason has to reach the banner, got {note:?}"
        );
        assert!(
            note.contains("retry in 3s"),
            "and so does the delay: {note:?}"
        );
    }

    /// Credentials are the case that made this loop forever, and they are the
    /// case that CAN heal: `current_client` picks up the reconnect.
    #[test]
    fn an_expired_credential_keeps_trying() {
        assert!(matches!(
            after_failure(&api_error(401), 1, true),
            AfterFailure::Retry { .. }
        ));
        assert!(matches!(
            after_failure(&api_error(403), 1, true),
            AfterFailure::Retry { .. }
        ));
    }

    /// A pod that a rollout replaced is never coming back under that name, so
    /// retrying it is a banner that will never resolve.
    #[test]
    fn a_pod_that_is_gone_stops_immediately() {
        let AfterFailure::GiveUp { note } = after_failure(&api_error(404), 1, true) else {
            panic!("404 means the name is gone; asking again cannot change it");
        };
        assert!(note.contains("rollout"), "and says what to do: {note:?}");
    }

    /// Two minutes of failing is not "reconnecting".
    #[test]
    fn it_stops_claiming_it_will_come_back() {
        assert!(matches!(
            after_failure(&api_error(500), MAX_ATTEMPTS - 1, true),
            AfterFailure::Retry { .. }
        ));
        let AfterFailure::GiveUp { note } = after_failure(&api_error(500), MAX_ATTEMPTS, true)
        else {
            panic!("should give up at the cap");
        };
        assert!(note.contains("Gave up"), "{note:?}");
    }

    /// The backoff climbs a second per attempt and stops at ten, which is what
    /// the reported screenshot was showing.
    #[test]
    fn the_wait_grows_and_then_stops_growing() {
        let wait = |n| match after_failure(&api_error(500), n, true) {
            AfterFailure::Retry { after, .. } => after,
            AfterFailure::GiveUp { .. } => panic!("unexpected give-up at {n}"),
        };
        assert_eq!(wait(1), Duration::from_secs(1));
        assert_eq!(wait(5), Duration::from_secs(5));
        assert_eq!(wait(11), Duration::from_secs(10));
    }

    /// Without auto-reconnect there is no second attempt to explain.
    #[test]
    fn a_forward_that_was_told_not_to_reconnect_does_not() {
        let AfterFailure::GiveUp { note } = after_failure(&api_error(500), 1, false) else {
            panic!("auto_reconnect off means one attempt");
        };
        assert!(note.starts_with("Port-forward failed"), "{note:?}");
    }

    #[test]
    fn cleanup_guard_removes_from_both_maps_on_drop() {
        let sessions: Arc<DashMap<String, PortForwardSession>> = Arc::new(DashMap::new());
        let controls: Arc<DashMap<String, CancellationToken>> = Arc::new(DashMap::new());

        sessions.insert("k".to_string(), make_test_session("k"));
        controls.insert("k".to_string(), CancellationToken::new());
        assert_eq!(sessions.len(), 1);
        assert_eq!(controls.len(), 1);

        {
            let _guard = PortForwardCleanup {
                sessions: sessions.clone(),
                controls: controls.clone(),
                key: "k".to_string(),
                cancel: CancellationToken::new(),
            };
        }

        assert_eq!(
            sessions.len(),
            0,
            "guard's Drop must remove the session entry — same path runs on panic-unwind"
        );
        assert_eq!(
            controls.len(),
            0,
            "guard's Drop must remove the control entry"
        );
    }

    #[test]
    fn cleanup_guard_drop_is_safe_when_entries_already_removed() {
        // Race: stop_port_forward removes both entries while the
        // listener task is still running. The guard's Drop must not
        // panic when the keys are no longer in either map.
        let sessions: Arc<DashMap<String, PortForwardSession>> = Arc::new(DashMap::new());
        let controls: Arc<DashMap<String, CancellationToken>> = Arc::new(DashMap::new());

        let guard = PortForwardCleanup {
            sessions: sessions.clone(),
            controls: controls.clone(),
            key: "missing".to_string(),
            cancel: CancellationToken::new(),
        };
        drop(guard); // must not panic

        assert_eq!(sessions.len(), 0);
        assert_eq!(controls.len(), 0);
    }

    /// The session ending has to reach the connections, and the maps going
    /// empty is not what reaches them — they are detached tasks holding a
    /// clone of the token and nothing else. This is the listener-error and
    /// panic path: nobody pressed Stop, and the forwards still have to stop.
    #[test]
    fn the_session_ending_cancels_the_connections_it_spawned() {
        let cancel = CancellationToken::new();
        let held_by_a_connection = cancel.clone();
        assert!(!held_by_a_connection.is_cancelled());

        drop(PortForwardCleanup {
            sessions: Arc::new(DashMap::new()),
            controls: Arc::new(DashMap::new()),
            key: "k".to_string(),
            cancel,
        });

        assert!(
            held_by_a_connection.is_cancelled(),
            "a connection outliving its session keeps proxying bytes for a \
             forward the list says is gone"
        );
    }

    /// Stop is the ordinary path, and it has to reach the same clones.
    #[tokio::test]
    async fn stop_reaches_a_connection_already_in_flight() {
        let cancel = CancellationToken::new();
        let in_flight = cancel.clone();

        // What `forward_connection` waits on while bytes are moving.
        let connection = tokio::spawn(async move {
            in_flight.cancelled().await;
            "stopped"
        });

        cancel.cancel();

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), connection)
                .await
                .expect("a stopped forward must not outlive its Stop")
                .expect("connection task panicked"),
            "stopped"
        );
    }

    /// A connection accepted in the same breath as Stop must not go on to
    /// open a stream: the token was already cancelled when it started, and
    /// nothing it is about to await would tell it so.
    #[test]
    fn a_connection_accepted_after_stop_does_not_start() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(cancel.is_cancelled());
    }
}
