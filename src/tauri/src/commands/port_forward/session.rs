//! Live port-forward sessions: bind a local TCP port, accept connections,
//! copy bytes through `kube::Api::portforward` to the pod `follow` says the
//! forward points at now.

use std::sync::Arc;

use dashmap::DashMap;
use kube::Api;
use tauri::State;
use tokio::net::TcpListener;
use tokio::sync::{watch, Notify};
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::state::streams::{Opened, SUBSCRIBE_TIMEOUT};
use crate::state::{AppState, PortForwardSession};
use crate::utils::require_namespace;

use super::follow::{current_client, follow, owner_of, replacement, Follow, Target};
use super::types::{ForwardNote, ForwardVia, PortForwardRequest, PortForwardSessionInfo, Reporter};

/// How many failures in a row before a connection stops claiming it is coming back.
///
/// Twelve at the capped ten seconds is about two minutes of trying, which
/// outlasts a node reboot but not a lunch break.
const MAX_ATTEMPTS: u32 = 12;

/// How often a forward looks at its pod when no connection prompts it to.
const LOOK_EVERY: Duration = Duration::from_secs(3);

/// How long a gone pod's owner has to put a ready one up before the forward
/// ends. Covers a `Recreate` rollout and a one-replica `StatefulSet` restart.
const PATIENCE: Duration = Duration::from_secs(60);

/// What to do after a failed attempt, and what to say about it.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum AfterFailure {
    /// Wait, then try again. The reason rides along: a banner that says only
    /// "Retry in 10s" cannot be acted on.
    Retry { after: Duration, note: ForwardNote },
    /// Stop, and say why.
    GiveUp { note: ForwardNote },
}

/// Whether a failed attempt says the pod itself is gone.
///
/// A deleted pod's upgrade is refused with a bare 404 rather than an API
/// `Status`, so `kube` reports it as a failed protocol switch. Read as a
/// transient error, it was retried for two minutes per connection while the
/// forward stayed green.
pub(super) fn pod_is_gone(err: &kube::Error) -> bool {
    match err {
        kube::Error::Api(response) => response.code == 404,
        kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(
            status,
        )) => status.as_u16() == 404,
        _ => false,
    }
}

pub(super) fn after_failure(err: &Error, attempt: u32, auto_reconnect: bool) -> AfterFailure {
    let text = err.to_string();
    if !auto_reconnect {
        return AfterFailure::GiveUp {
            note: ForwardNote::Said { text },
        };
    }
    if attempt >= MAX_ATTEMPTS {
        return AfterFailure::GiveUp {
            note: ForwardNote::GaveUp {
                text,
                attempts: attempt,
            },
        };
    }
    let after = Duration::from_secs(u64::from(attempt).min(10));
    AfterFailure::Retry {
        after,
        note: ForwardNote::Retrying {
            text,
            after_secs: after.as_secs(),
        },
    }
}

/// What every connection of one forward shares.
#[derive(Clone)]
struct Shared {
    clients: Arc<crate::client::K8sClientManager>,
    context: String,
    namespace: String,
    auto_reconnect: bool,
    report: Reporter,
    target: watch::Receiver<Target>,
    suspect: Arc<Notify>,
    cancel: CancellationToken,
}

async fn forward_connection(shared: Shared, mut local_stream: tokio::net::TcpStream) {
    let Shared {
        clients,
        context,
        namespace,
        auto_reconnect,
        report,
        mut target,
        suspect,
        cancel,
    } = shared;
    let mut attempt: u32 = 0;

    loop {
        // Checked at the top as well as inside the waits: a connection
        // accepted in the same breath as Stop would otherwise open a stream
        // to a session that no longer exists.
        if cancel.is_cancelled() {
            return;
        }
        let Target { pod, remote_port } = target.borrow_and_update().clone();
        let attempt_result = match current_client(&clients, &context) {
            Ok(client) => {
                let pod_api: Api<k8s_openapi::api::core::v1::Pod> =
                    Api::namespaced(client, &namespace);
                pod_api
                    .portforward(&pod, &[remote_port])
                    .await
                    .map_err(|err| (pod_is_gone(&err), Error::from(err)))
            }
            // Disconnected right now: the user reconnecting is exactly the
            // recovery this loop is waiting for.
            Err(why) => Err((false, why)),
        };

        match attempt_result {
            Ok(mut portforwarder) => {
                if attempt > 0 {
                    report.say(&pod, remote_port, "reconnected", None, Some(attempt));
                }
                if let Some(mut remote_stream) = portforwarder.take_stream(remote_port) {
                    // Stop has to reach the bytes in flight, not just the door:
                    // losing the select drops both halves and closes the socket.
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(&mut local_stream, &mut remote_stream) => {}
                        () = cancel.cancelled() => {}
                    }
                } else {
                    report.say(
                        &pod,
                        remote_port,
                        "error",
                        Some(ForwardNote::NoStream),
                        None,
                    );
                }
                break;
            }
            // The pod is gone: the follower moves the forward or ends it, and
            // this connection goes wherever that lands instead of retrying a
            // name that will not come back.
            Err((true, _)) => {
                suspect.notify_one();
                tokio::select! {
                    changed = target.changed() => if changed.is_err() { return },
                    () = cancel.cancelled() => return,
                }
            }
            Err((false, err)) => {
                attempt += 1;
                match after_failure(&err, attempt, auto_reconnect) {
                    AfterFailure::GiveUp { note } => {
                        report.say(&pod, remote_port, "error", Some(note), Some(attempt));
                        break;
                    }
                    AfterFailure::Retry { after, note } => {
                        report.say(&pod, remote_port, "reconnecting", Some(note), Some(attempt));
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

/// Removes the session's row on every exit, a panic's included.
struct Leave {
    sessions: Arc<DashMap<String, PortForwardSession>>,
    key: String,
}

impl Drop for Leave {
    fn drop(&mut self) {
        self.sessions.remove(&self.key);
    }
}

/// One forward, from the subscribe gate to its terminal event.
///
/// Ends on exactly one of `stopped` (asked to) and `failed` (with the reason),
/// and closes the local port before saying either: a listener left open after
/// the forward is over is the silent hang this replaced.
async fn run(
    mut opened: Opened,
    listener: TcpListener,
    spec: Follow,
    report: Reporter,
    start: Target,
    sessions: Arc<DashMap<String, PortForwardSession>>,
) {
    let _leave = Leave {
        sessions: sessions.clone(),
        key: report.id.clone(),
    };
    if !opened.wait_for_subscriber(SUBSCRIBE_TIMEOUT).await {
        sessions.remove(&report.id);
        report.say(&start.pod, start.remote_port, "stopped", None, None);
        return;
    }
    let (cancel, held) = opened.split();
    let (target_tx, target_rx) = watch::channel(start.clone());
    let suspect = Arc::new(Notify::new());
    let shared = Shared {
        clients: spec.clients.clone(),
        context: spec.context.clone(),
        namespace: spec.namespace.clone(),
        auto_reconnect: spec.auto_reconnect,
        report: report.clone(),
        target: target_rx,
        suspect: suspect.clone(),
        cancel: cancel.clone(),
    };

    report.say(&start.pod, start.remote_port, "listening", None, None);
    let followed = follow(&spec, &report, &sessions, &target_tx, &suspect);
    tokio::pin!(followed);

    let ending = loop {
        tokio::select! {
            () = cancel.cancelled() => break None,
            note = &mut followed => break Some(note),
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(forward_connection(shared.clone(), stream));
                }
                Err(err) => break Some(ForwardNote::ListenerFailed { text: err.to_string() }),
            },
        }
    };

    drop(listener);
    drop(held);
    cancel.cancel();
    sessions.remove(&report.id);
    let last = target_tx.borrow().clone();
    match ending {
        None => report.say(&last.pod, last.remote_port, "stopped", None, None),
        Some(note) => report.say(&last.pod, last.remote_port, "failed", Some(note), None),
    }
}

pub(super) async fn bind(port: u16) -> Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|err| Error::Connection(format!("Failed to bind port {port}: {err}")))
}

fn info_of(session: &PortForwardSession) -> PortForwardSessionInfo {
    PortForwardSessionInfo {
        id: session.id.clone(),
        context: session.context.clone(),
        pod: session.pod.clone(),
        namespace: session.namespace.clone(),
        local_port: session.local_port,
        remote_port: session.remote_port,
        auto_reconnect: session.auto_reconnect,
        created_at: session.created_at.to_rfc3339(),
        via: session.via.clone(),
    }
}

/// Everything a start needs once the target and the local port are settled.
struct Start {
    context: String,
    namespace: String,
    target: Target,
    via: ForwardVia,
    auto_reconnect: bool,
}

fn start(state: &AppState, listener: TcpListener, plan: Start) -> Result<PortForwardSessionInfo> {
    let local_port = listener.local_addr().map_err(Error::Io)?.port();
    let id = crate::utils::generate_id("pf");
    let session = PortForwardSession {
        id: id.clone(),
        context: plan.context.clone(),
        pod: plan.target.pod.clone(),
        namespace: plan.namespace.clone(),
        local_port,
        remote_port: plan.target.remote_port,
        auto_reconnect: plan.auto_reconnect,
        created_at: chrono::Utc::now(),
        via: plan.via.clone(),
    };
    state
        .port_forward_sessions
        .insert(id.clone(), session.clone());
    let opened = state.port_forwards.open(id.clone());
    let report = Reporter {
        event_tx: state.event_tx.clone(),
        id,
        namespace: plan.namespace.clone(),
        local_port,
    };
    let spec = Follow {
        clients: state.client_manager.clone(),
        context: plan.context,
        namespace: plan.namespace,
        via: plan.via,
        auto_reconnect: plan.auto_reconnect,
        every: LOOK_EVERY,
        patience: PATIENCE,
    };
    tokio::spawn(run(
        opened,
        listener,
        spec,
        report,
        plan.target,
        state.port_forward_sessions.clone(),
    ));
    Ok(info_of(&session))
}

fn connected_context(state: &AppState) -> Result<(String, kube::Client)> {
    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;
    let client = current_client(&state.client_manager, &context)?;
    Ok((context, client))
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
    crate::validation::validate_dns_subdomain(&pod)?;
    let (context, client) = connected_context(&state)?;
    let namespace = require_namespace(namespace, String::new())?;
    let listener = bind(config.local_port).await?;
    let via = owner_of(&client, &namespace, &pod).await;
    start(
        &state,
        listener,
        Start {
            context,
            namespace,
            target: Target {
                pod,
                remote_port: config.remote_port,
            },
            via,
            auto_reconnect: config.auto_reconnect,
        },
    )
}

/// Start port forwarding to a Service, through a ready pod behind it, the way
/// `kubectl port-forward svc/...` does. `config.remote_port` is the Service
/// port; the pod-side port is resolved from its `targetPort`.
#[tauri::command]
pub async fn port_forward_service(
    service: String,
    namespace: Option<String>,
    config: PortForwardRequest,
    state: State<'_, AppState>,
) -> Result<PortForwardSessionInfo> {
    if config.local_port == 0 || config.remote_port == 0 {
        return Err(Error::InvalidInput(
            "Ports must be greater than 0".to_string(),
        ));
    }
    crate::validation::validate_dns_label(&service)?;
    let (context, client) = connected_context(&state)?;
    let namespace = require_namespace(namespace, String::new())?;
    let via = ForwardVia::Service {
        name: service.clone(),
        port: config.remote_port,
    };
    let target = replacement(&client, &namespace, &via, "", config.remote_port)
        .await?
        .ok_or(Error::NoReadyPod { service })?;
    let listener = bind(config.local_port).await?;
    start(
        &state,
        listener,
        Start {
            context,
            namespace,
            target,
            via,
            auto_reconnect: config.auto_reconnect,
        },
    )
}

/// The frontend's listener is up: the forward may start saying things.
/// A no-op for a forward that has already ended.
#[tauri::command]
pub fn port_forward_subscribed(forward_id: String, state: State<'_, AppState>) -> Result<()> {
    if !state.port_forwards.subscribed(&forward_id) {
        tracing::debug!("Port-forward {forward_id} subscribed after it ended");
    }
    Ok(())
}

/// Stop a running port-forward session
#[tauri::command]
pub fn stop_port_forward(forward_id: String, state: State<'_, AppState>) -> Result<()> {
    state.port_forward_sessions.remove(&forward_id);
    let _ = state.port_forwards.stop(&forward_id);
    Ok(())
}

/// List active port-forward sessions
#[tauri::command]
pub fn list_port_forwards(state: State<'_, AppState>) -> Result<Vec<PortForwardSessionInfo>> {
    Ok(state
        .port_forward_sessions
        .iter()
        .map(|entry| info_of(entry.value()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::{connected, failure};
    use crate::client::served::ServedIndex;
    use crate::state::AppEvent;

    fn api_error(code: u16) -> kube::Error {
        kube::Error::Api(Box::new(kube::core::Status {
            status: Some(kube::core::response::StatusSummary::Failure),
            message: format!("the server responded with {code}"),
            reason: "Whatever".into(),
            code,
            metadata: None,
            details: None,
        }))
    }

    fn upgrade_refused(code: u16) -> kube::Error {
        kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(
            http::StatusCode::from_u16(code).unwrap(),
        ))
    }

    /// A user watched "Retry in 10s" repeat with no way to learn why: the
    /// reason was thrown away and only the delay survived.
    #[test]
    fn a_retry_says_why_it_is_retrying() {
        let AfterFailure::Retry { note, .. } = after_failure(&Error::from(api_error(500)), 3, true)
        else {
            panic!("a 500 may pass, so it should retry");
        };
        let ForwardNote::Retrying { text, after_secs } = note else {
            panic!("a retry carries its reason and its delay");
        };
        assert!(text.contains("500"), "{text:?}");
        assert_eq!(after_secs, 3);
    }

    /// Credentials are the case that CAN heal: `current_client` picks up the reconnect.
    #[test]
    fn an_expired_credential_keeps_trying() {
        for code in [401, 403] {
            assert!(matches!(
                after_failure(&Error::from(api_error(code)), 1, true),
                AfterFailure::Retry { .. }
            ));
        }
    }

    /// A deleted pod's upgrade comes back as a bare 404 protocol switch, not
    /// an API status, and was retried for two minutes per connection.
    #[test]
    fn a_deleted_pod_is_recognised_in_both_shapes() {
        assert!(pod_is_gone(&api_error(404)));
        assert!(pod_is_gone(&upgrade_refused(404)));
        assert!(!pod_is_gone(&upgrade_refused(403)));
        assert!(!pod_is_gone(&api_error(500)));
    }

    /// Two minutes of failing is not "reconnecting".
    #[test]
    fn it_stops_claiming_it_will_come_back() {
        let err = Error::from(api_error(500));
        assert!(matches!(
            after_failure(&err, MAX_ATTEMPTS - 1, true),
            AfterFailure::Retry { .. }
        ));
        assert!(matches!(
            after_failure(&err, MAX_ATTEMPTS, true),
            AfterFailure::GiveUp {
                note: ForwardNote::GaveUp { .. }
            }
        ));
    }

    /// The backoff climbs a second per attempt and stops at ten.
    #[test]
    fn the_wait_grows_and_then_stops_growing() {
        let err = Error::from(api_error(500));
        let wait = |n| match after_failure(&err, n, true) {
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
        assert!(matches!(
            after_failure(&Error::from(api_error(500)), 1, false),
            AfterFailure::GiveUp {
                note: ForwardNote::Said { .. }
            }
        ));
    }

    /// The row has to leave with the task on every exit, a panic's included.
    #[test]
    fn the_session_row_leaves_with_its_task() {
        let sessions: Arc<DashMap<String, PortForwardSession>> = Arc::new(DashMap::new());
        sessions.insert("k".into(), session("k", "api-0"));
        drop(Leave {
            sessions: sessions.clone(),
            key: "k".into(),
        });
        assert!(sessions.is_empty());
    }

    fn session(id: &str, pod: &str) -> PortForwardSession {
        PortForwardSession {
            id: id.into(),
            context: "fake".into(),
            pod: pod.into(),
            namespace: "shop".into(),
            local_port: 0,
            remote_port: 8080,
            auto_reconnect: true,
            created_at: chrono::Utc::now(),
            via: ForwardVia::Pod,
        }
    }

    struct Running {
        state: AppState,
        events: tokio::sync::broadcast::Receiver<AppEvent>,
        port: u16,
    }

    /// A forward to `api-0` against a cluster that answers `answer`, looked
    /// at every few milliseconds.
    async fn running(
        via: ForwardVia,
        auto_reconnect: bool,
        answer: impl Fn(&str, usize) -> (u16, String) + Send + Sync + 'static,
    ) -> Running {
        let (state, _) = connected(ServedIndex::default(), answer).await;
        let events = state.event_tx.subscribe();
        let listener = bind(0).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        state
            .port_forward_sessions
            .insert("pf-1".into(), session("pf-1", "api-0"));
        let opened = state.port_forwards.open("pf-1".into());
        let report = Reporter {
            event_tx: state.event_tx.clone(),
            id: "pf-1".into(),
            namespace: "shop".into(),
            local_port: port,
        };
        let spec = Follow {
            clients: state.client_manager.clone(),
            context: "fake".into(),
            namespace: "shop".into(),
            via,
            auto_reconnect,
            every: Duration::from_millis(20),
            patience: Duration::from_millis(200),
        };
        tokio::spawn(run(
            opened,
            listener,
            spec,
            report,
            Target {
                pod: "api-0".into(),
                remote_port: 8080,
            },
            state.port_forward_sessions.clone(),
        ));
        Running {
            state,
            events,
            port,
        }
    }

    async fn next_status(
        events: &mut tokio::sync::broadcast::Receiver<AppEvent>,
    ) -> (String, Option<ForwardNote>) {
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("an event within five seconds")
                .expect("the channel is open");
            if let AppEvent::PortForwardStatus { status, note, .. } = event {
                return (status, note);
            }
        }
    }

    /// The reported bug: after a restart the forward stayed green against a
    /// pod that no longer existed, and its port took connections and hung.
    #[tokio::test]
    async fn a_forward_whose_pod_is_deleted_fails_and_closes_its_port() {
        let mut forward = running(ForwardVia::Pod, true, |_, _| failure(404, "NotFound")).await;
        assert!(forward.state.port_forwards.subscribed("pf-1"));

        assert_eq!(next_status(&mut forward.events).await.0, "listening");
        let (status, note) = next_status(&mut forward.events).await;
        assert_eq!(status, "failed");
        assert_eq!(
            note,
            Some(ForwardNote::PodGone {
                pod: "api-0".into()
            })
        );
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", forward.port))
                .await
                .is_err(),
            "the local port must close with the forward, not hang"
        );
        assert!(forward.state.port_forward_sessions.is_empty());
    }

    /// Tauri events have no replay, so nothing is said before the frontend
    /// says it is listening.
    #[tokio::test]
    async fn a_forward_says_nothing_until_it_is_subscribed_to() {
        let mut forward = running(ForwardVia::Pod, true, |_, _| failure(404, "NotFound")).await;
        sleep(Duration::from_millis(150)).await;
        assert!(matches!(
            forward.events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        assert!(forward.state.port_forwards.subscribed("pf-1"));
        assert_eq!(next_status(&mut forward.events).await.0, "listening");
    }

    /// Stop ends on `stopped`, once, and never on `failed`.
    #[tokio::test]
    async fn a_stopped_forward_says_stopped_and_nothing_after() {
        let pod = serde_json::json!({ "metadata": { "name": "api-0", "namespace": "shop" } });
        let mut forward = running(ForwardVia::Pod, true, move |path, _| match path {
            "/api/v1/namespaces/shop/pods/api-0" => (200, pod.to_string()),
            _ => failure(404, "NotFound"),
        })
        .await;
        assert!(forward.state.port_forwards.subscribed("pf-1"));
        assert_eq!(next_status(&mut forward.events).await.0, "listening");

        assert!(forward.state.port_forwards.stop("pf-1"));
        assert_eq!(next_status(&mut forward.events).await.0, "stopped");
        sleep(Duration::from_millis(100)).await;
        assert!(
            forward.events.try_recv().is_err(),
            "one terminal event only"
        );
    }
}
