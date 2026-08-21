//! `AppEvent` enum and the per-variant payload helpers carried over
//! the broadcast channel to the frontend.

use crate::logs::{LogFormat, LogLevel};
use std::collections::BTreeMap;

/// One log line as carried inside a `LogBatch`. Mirrors the subset of
/// `LogLine` that the frontend consumes — pod/container/namespace are
/// per-batch context (already known by the receiving hook) so they're
/// omitted here to keep the payload small.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogLineEvent {
    pub message: String,
    pub timestamp: Option<String>,
    pub level: Option<LogLevel>,
    pub format: LogFormat,
    pub fields: Option<BTreeMap<String, String>>,
    pub raw: String,
}

/// Operation type for a resource-watch event. Mirrors `kube::runtime::watcher::Event`
/// flattened to a string the frontend can switch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchOp {
    /// Resource was added or updated (the watcher merges these).
    Applied,
    /// Resource was deleted.
    Deleted,
    /// A (re)sync started. What follows, up to the matching `synced`,
    /// is the complete new state — but it is only complete once
    /// `synced` arrives, so the frontend stages the burst instead of
    /// clearing what it holds. Clearing here is what painted "no
    /// resources in the current scope" over a healthy cluster for the
    /// whole length of the burst: the list query is long since loaded,
    /// so nothing renders a skeleton, and a resync is exactly when an
    /// apiserver restart or a "too old resource version" makes a
    /// reader look at their cluster.
    Restarted,
    /// The resync is complete: what was staged since `restarted` is
    /// the whole collection and can be swapped in as one update.
    Synced,
    /// Watch failed N times in a row without recovery (typically RBAC
    /// `watch` verb missing, or kube-apiserver unreachable). The
    /// frontend should fall back to periodic refresh and tell the
    /// user. The watcher task keeps retrying in the background; if
    /// it eventually recovers, an `applied`/`restarted` resets the
    /// state and a fresh `failed` would only be emitted after another
    /// streak of errors.
    Failed,
}

/// One change inside a `ResourceWatchEvent` batch.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WatchChange {
    pub op: WatchOp,
    /// The transformed resource on `applied`/`deleted`. `None` on the
    /// resync markers and on `failed`, which say something about the
    /// stream rather than about an object.
    pub resource: Option<serde_json::Value>,
}

/// Why a long-lived stream stopped without the frontend asking it to.
///
/// The two read completely differently on screen and only one of them
/// has an action behind it, so the distinction has to survive the trip
/// to the frontend rather than being flattened into one message.
// kebab-case, not lowercase: `gone` and `broken` are unaffected, and a
// multi-word variant has to arrive as `no-previous-run` rather than as
// an unreadable `nopreviousrun`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StreamFailureKind {
    /// The thing being streamed is no longer there: the pod was
    /// deleted, the container exited, the log source reached EOF while
    /// following. Expected, and no amount of retrying brings it back.
    Gone,
    /// The transport failed while the resource itself may well still be
    /// running: a rejected WebSocket upgrade, an unreachable
    /// kube-apiserver, a read error mid-stream. Retrying is worth
    /// offering.
    Broken,
    /// The previous run that was asked for does not exist: the
    /// container has never restarted, so there is nothing before the
    /// run already on screen. Nothing is wrong — the question has no
    /// answer, and the control that asked it should say so instead of
    /// reporting a failure.
    NoPreviousRun,
}

/// The apiserver's phrasing when `--previous` is asked of a container
/// that has never restarted: a 400 reading `previous terminated
/// container "wait-for-db" in pod "init-demo" not found`.
///
/// It has to be recognised before the generic rule below, which sees
/// the trailing "not found" and would announce that the pod is gone —
/// the exact lie `StreamFailureKind` exists to prevent, aimed this time
/// at a pod sitting there perfectly intact.
#[must_use]
pub fn is_missing_previous_run(text: &str) -> bool {
    text.contains("previous terminated container")
}

impl StreamFailureKind {
    /// Classify a backend error as "the resource went away" vs "the
    /// connection broke".
    ///
    /// Only a `NotFound` — either our own variant or a 404 the
    /// apiserver phrased as `pods "x" not found` — proves the resource
    /// is gone. Everything else is treated as a transport failure,
    /// deliberately: telling someone their pod is gone when it is
    /// actually running sends them hunting through a healthy cluster,
    /// which is the failure mode this whole event exists to kill.
    #[must_use]
    pub fn classify(error: &crate::error::Error) -> Self {
        if matches!(error, crate::error::Error::NoPreviousRun { .. }) {
            return Self::NoPreviousRun;
        }
        if matches!(error, crate::error::Error::NotFound { .. }) {
            return Self::Gone;
        }
        let text = error.to_string();
        if is_missing_previous_run(&text) {
            return Self::NoPreviousRun;
        }
        let text = text.to_lowercase();
        if text.contains("not found") || text.contains("notfound") {
            Self::Gone
        } else {
            Self::Broken
        }
    }
}

/// Peel the Rust error wrapping off a message before it goes on screen.
///
/// `Error`'s `Display` prepends its variant label and each call site
/// prepends its own context, so a rejected exec upgrade arrives as
/// `Terminal error: Failed to exec: failed to upgrade to a WebSocket
/// connection: 500`. Only the innermost clause tells the reader
/// anything; the prefixes are bookkeeping from layers they never see.
#[must_use]
pub fn readable_cause(error: &crate::error::Error) -> String {
    const WRAPPERS: [&str; 8] = [
        "Terminal error: ",
        "Log streaming error: ",
        "Kubernetes API error: ",
        "Connection error: ",
        "Internal error: ",
        "Failed to exec: ",
        "Failed to start log stream: ",
        "Failed to get logs: ",
    ];

    let text = error.to_string();
    let mut rest = text.trim();
    while let Some(stripped) = WRAPPERS.iter().find_map(|w| rest.strip_prefix(w)) {
        rest = stripped.trim();
    }
    if rest.is_empty() {
        text.trim().to_string()
    } else {
        rest.to_string()
    }
}

/// Events that can be broadcast to frontend
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum AppEvent {
    /// Batch of log lines for a single stream. The streamer flushes
    /// every ~50ms (or sooner if the buffer fills) so that verbose
    /// pods don't generate one Tauri round-trip per line. Always
    /// non-empty.
    LogBatch {
        stream_id: String,
        lines: Vec<LogLineEvent>,
    },
    /// A batch of Kubernetes watch changes for one stream. Forwarded
    /// to the frontend so it can update the `TanStack` Query cache
    /// directly, replacing the old 2s polling refresh model. Each
    /// `resource` JSON is the typed resource serialized via the same
    /// path the existing list/get commands use.
    ///
    /// Batched for the same reason as `LogBatch`: one Tauri event per
    /// watch event is one JS task per watch event, which React cannot
    /// batch across, so a thousand-object init burst cost a thousand
    /// renders — each rebuilding the whole table — and a thousand
    /// slots in a broadcast channel that holds a thousand.
    ///
    /// `changes` is in arrival order and never empty.
    ResourceWatchEvent {
        stream_id: String,
        changes: Vec<WatchChange>,
        /// Set on `failed` batches with the error string (RBAC
        /// denial, network error, etc.). None for every other op.
        error: Option<String>,
    },
    /// A log stream or terminal session stopped on its own — not
    /// because the frontend closed it.
    ///
    /// Without this the failure only ever reached `tracing`, and the
    /// panel that was waiting on the stream rendered its empty state:
    /// "No output yet" for a stream that died on connect, a blank
    /// terminal for an exec whose WebSocket upgrade was rejected after
    /// `open_pod_shell` had already handed back a session id. An empty
    /// state that means "it broke" sends the reader looking for the
    /// problem in their cluster.
    ///
    /// `stream_id` is the log stream id or the terminal session id —
    /// whichever the receiving panel is holding. `message` is written
    /// to be read by a person, not a `{:?}` of a Rust error.
    StreamFailed {
        stream_id: String,
        kind: StreamFailureKind,
        message: String,
    },
    /// A batch of cross-cluster search matches from one cluster.
    ///
    /// Emitted per (cluster, kind) as soon as that query answers, so a
    /// four-cluster search paints three clusters' results while the
    /// fourth is still connecting.
    SearchHits {
        search_id: String,
        context: String,
        hits: Vec<crate::search::SearchHit>,
    },
    /// One cluster's state within a search.
    ///
    /// Every active cluster emits exactly one terminal status —
    /// `done`, `failed` or `skipped` — so the frontend never has to
    /// guess whether an empty result list means "nothing matched" or
    /// "this cluster never answered". `reason` + `message` carry the
    /// why in words the reader can act on.
    SearchStatus {
        search_id: String,
        context: String,
        status: crate::search::SearchContextStatus,
        reason: Option<crate::search::SearchFailureKind>,
        message: Option<String>,
        matched: u32,
        truncated: bool,
    },
    /// Terminal output received
    TerminalOutput { session_id: String, data: String },
    /// Terminal session closed
    TerminalClosed {
        session_id: String,
        status: Option<String>,
    },
    /// Port-forward status update
    PortForwardStatus {
        id: String,
        pod: String,
        namespace: String,
        local_port: u16,
        remote_port: u16,
        status: String,
        message: Option<String>,
        attempt: Option<u32>,
    },
    /// Auth URL requested for interactive login
    AuthUrlRequested {
        context: String,
        url: String,
        flow: String,
        session_id: Option<String>,
        /// Where the provider is expected to send the browser back, when the
        /// flow has one. A provider only accepts an address its client has
        /// registered, and the reader is the only person who can add it —
        /// naming it while they wait beats naming it once the wait times out.
        redirect_uri: Option<String>,
    },
    /// Auth flow completed
    AuthFlowCompleted {
        session_id: String,
        context: String,
        success: bool,
        message: Option<String>,
    },
    /// Auth flow cancelled
    AuthFlowCancelled {
        session_id: String,
        context: String,
        message: Option<String>,
    },
    /// Auth terminal session created (for interactive exec auth)
    AuthTerminalSessionCreated {
        auth_session_id: String,
        terminal_session_id: String,
        context: String,
        command: String,
    },
    /// Error occurred
    Error { code: String, message: String },
}

impl AppEvent {
    /// Tauri event channel name. Frontend `listen("...")` subscribes
    /// per-channel.
    #[must_use]
    pub fn channel(&self) -> &'static str {
        match self {
            AppEvent::LogBatch { .. } => "log-batch",
            AppEvent::StreamFailed { .. } => "stream-failed",
            AppEvent::ResourceWatchEvent { .. } => "resource-event",
            AppEvent::SearchHits { .. } => "search-hits",
            AppEvent::SearchStatus { .. } => "search-status",
            AppEvent::TerminalOutput { .. } => "terminal-output",
            AppEvent::TerminalClosed { .. } => "terminal-closed",
            AppEvent::PortForwardStatus { .. } => "port-forward-status",
            AppEvent::AuthUrlRequested { .. } => "auth-url-requested",
            AppEvent::AuthFlowCompleted { .. } => "auth-flow-completed",
            AppEvent::AuthFlowCancelled { .. } => "auth-flow-cancelled",
            AppEvent::AuthTerminalSessionCreated { .. } => "auth-terminal-session-created",
            AppEvent::Error { .. } => "app-error",
        }
    }

    /// Frontend-facing payload. We DON'T `serde_json::to_value(self)`
    /// because `AppEvent` is `#[serde(tag = "type", content = "data")]` —
    /// that would wrap each payload in `{ "type": ..., "data": {...} }`
    /// and force every frontend listener to dig through `event.payload.data.*`.
    /// Each variant explicitly returns the flat object the frontend hooks
    /// expect (`event.payload.session_id`, etc.).
    ///
    /// **Adding a new variant?** You MUST extend this match — the
    /// `#[deny(non_exhaustive_omitted_patterns)]` style enforced by the
    /// exhaustive match below means a new variant fails to compile until
    /// it has a payload, and the unit test below fails until the payload
    /// is structurally flat (no `type` wrapper key).
    #[must_use]
    pub fn payload(&self) -> serde_json::Value {
        match self {
            AppEvent::LogBatch { stream_id, lines } => serde_json::json!({
                "stream_id": stream_id,
                "lines": lines,
            }),
            AppEvent::StreamFailed {
                stream_id,
                kind,
                message,
            } => serde_json::json!({
                "stream_id": stream_id,
                "kind": kind,
                "message": message,
            }),
            AppEvent::ResourceWatchEvent {
                stream_id,
                changes,
                error,
            } => serde_json::json!({
                "stream_id": stream_id,
                "changes": changes,
                "error": error,
            }),
            AppEvent::SearchHits {
                search_id,
                context,
                hits,
            } => serde_json::json!({
                "search_id": search_id,
                "context": context,
                "hits": hits,
            }),
            AppEvent::SearchStatus {
                search_id,
                context,
                status,
                reason,
                message,
                matched,
                truncated,
            } => serde_json::json!({
                "search_id": search_id,
                "context": context,
                "status": status,
                "reason": reason,
                "message": message,
                "matched": matched,
                "truncated": truncated,
            }),
            AppEvent::TerminalOutput { session_id, data } => serde_json::json!({
                "session_id": session_id,
                "data": data,
            }),
            AppEvent::TerminalClosed { session_id, status } => serde_json::json!({
                "session_id": session_id,
                "status": status,
            }),
            AppEvent::PortForwardStatus {
                id,
                pod,
                namespace,
                local_port,
                remote_port,
                status,
                message,
                attempt,
            } => serde_json::json!({
                "id": id,
                "pod": pod,
                "namespace": namespace,
                "local_port": local_port,
                "remote_port": remote_port,
                "status": status,
                "message": message,
                "attempt": attempt,
            }),
            AppEvent::AuthUrlRequested {
                context,
                url,
                flow,
                session_id,
                redirect_uri,
            } => serde_json::json!({
                "context": context,
                "url": url,
                "flow": flow,
                "session_id": session_id,
                "redirect_uri": redirect_uri,
            }),
            AppEvent::AuthFlowCompleted {
                session_id,
                context,
                success,
                message,
            } => serde_json::json!({
                "session_id": session_id,
                "context": context,
                "success": success,
                "message": message,
            }),
            AppEvent::AuthFlowCancelled {
                session_id,
                context,
                message,
            } => serde_json::json!({
                "session_id": session_id,
                "context": context,
                "message": message,
            }),
            AppEvent::AuthTerminalSessionCreated {
                auth_session_id,
                terminal_session_id,
                context,
                command,
            } => serde_json::json!({
                "auth_session_id": auth_session_id,
                "terminal_session_id": terminal_session_id,
                "context": context,
                "command": command,
            }),
            AppEvent::Error { code, message } => serde_json::json!({
                "code": code,
                "message": message,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `AppEvent` payload must be a flat object — no `type`
    /// wrapper key, no `data` nesting. The frontend hooks read fields
    /// like `event.payload.context` directly; the `#[serde(tag, content)]`
    /// representation that `serde_json::to_value(self)` would produce
    /// instead sits one level deeper and silently breaks every consumer.
    /// The bug we hit in v2.1.0 was exactly this for
    /// `AuthTerminalSessionCreated` — modal opened with empty
    /// context/command and a `terminalSessionId: undefined` that
    /// disconnected the inner terminal. This test pins the contract.
    #[test]
    fn payload_is_flat_object_for_every_variant() {
        let samples = [
            AppEvent::AuthTerminalSessionCreated {
                auth_session_id: "auth-1".into(),
                terminal_session_id: "term-1".into(),
                context: "infra-eu1".into(),
                command: "kubectl oidc-login".into(),
            },
            AppEvent::AuthUrlRequested {
                context: "infra-eu1".into(),
                url: "https://example".into(),
                flow: "exec".into(),
                session_id: Some("auth-1".into()),
                redirect_uri: None,
            },
            AppEvent::AuthFlowCompleted {
                session_id: "auth-1".into(),
                context: "infra-eu1".into(),
                success: true,
                message: None,
            },
            AppEvent::Error {
                code: "X".into(),
                message: "y".into(),
            },
            AppEvent::StreamFailed {
                stream_id: "log-1".into(),
                kind: StreamFailureKind::Gone,
                message: "gone".into(),
            },
            AppEvent::SearchHits {
                search_id: "search-1".into(),
                context: "prod".into(),
                hits: vec![],
            },
            AppEvent::SearchStatus {
                search_id: "search-1".into(),
                context: "prod".into(),
                status: crate::search::SearchContextStatus::Done,
                reason: None,
                message: None,
                matched: 0,
                truncated: false,
            },
            AppEvent::ResourceWatchEvent {
                stream_id: "rw-1".into(),
                changes: vec![WatchChange {
                    op: WatchOp::Applied,
                    resource: Some(serde_json::json!({ "name": "api-0" })),
                }],
                error: None,
            },
        ];

        for event in &samples {
            let payload = event.payload();
            let obj = payload
                .as_object()
                .unwrap_or_else(|| panic!("{} payload was not a JSON object", event.channel()));
            assert!(
                !obj.contains_key("type"),
                "{} payload looks tagged-enum-wrapped (has `type` key) — frontend reads fields at top level",
                event.channel()
            );
            assert!(
                !obj.contains_key("data"),
                "{} payload looks tagged-enum-wrapped (has `data` key)",
                event.channel()
            );
        }
    }

    /// Specific guard for the v2.1.0 bug: every field consumed by the
    /// frontend's `<AuthTerminal>` modal must be present at the top
    /// level of the payload.
    #[test]
    fn auth_terminal_session_created_payload_is_flat_with_modal_fields() {
        let event = AppEvent::AuthTerminalSessionCreated {
            auth_session_id: "auth-1".into(),
            terminal_session_id: "term-1".into(),
            context: "infra-eu1".into(),
            command: "kubectl oidc-login get-token".into(),
        };
        let payload = event.payload();

        assert_eq!(
            payload.get("auth_session_id").and_then(|v| v.as_str()),
            Some("auth-1"),
        );
        assert_eq!(
            payload.get("terminal_session_id").and_then(|v| v.as_str()),
            Some("term-1"),
        );
        assert_eq!(
            payload.get("context").and_then(|v| v.as_str()),
            Some("infra-eu1"),
        );
        assert_eq!(
            payload.get("command").and_then(|v| v.as_str()),
            Some("kubectl oidc-login get-token"),
        );
    }

    #[test]
    fn channel_names_are_kebab_case() {
        // Tauri convention. Frontend listens on these strings.
        let cases = [
            (
                AppEvent::AuthTerminalSessionCreated {
                    auth_session_id: String::new(),
                    terminal_session_id: String::new(),
                    context: String::new(),
                    command: String::new(),
                },
                "auth-terminal-session-created",
            ),
            (
                AppEvent::AuthUrlRequested {
                    context: String::new(),
                    url: String::new(),
                    flow: String::new(),
                    session_id: None,
                    redirect_uri: None,
                },
                "auth-url-requested",
            ),
            (
                AppEvent::StreamFailed {
                    stream_id: String::new(),
                    kind: StreamFailureKind::Broken,
                    message: String::new(),
                },
                "stream-failed",
            ),
        ];

        for (event, expected) in cases {
            assert_eq!(event.channel(), expected);
        }
    }

    /// The frontend reads `changes` as a list and switches on each
    /// `op` as a bare lowercase string. A batch arriving as anything
    /// but an array — or an op serialized as `Synced` — means every
    /// consumer silently applies nothing.
    #[test]
    fn resource_watch_payload_carries_an_ordered_list_of_ops() {
        let payload = AppEvent::ResourceWatchEvent {
            stream_id: "rw-1".into(),
            changes: vec![
                WatchChange {
                    op: WatchOp::Restarted,
                    resource: None,
                },
                WatchChange {
                    op: WatchOp::Applied,
                    resource: Some(serde_json::json!({ "name": "api-0" })),
                },
                WatchChange {
                    op: WatchOp::Synced,
                    resource: None,
                },
            ],
            error: None,
        }
        .payload();

        let changes = payload
            .get("changes")
            .and_then(|c| c.as_array())
            .expect("changes must be a JSON array");
        let ops: Vec<_> = changes
            .iter()
            .map(|c| c.get("op").and_then(|o| o.as_str()).unwrap())
            .collect();
        assert_eq!(ops, vec!["restarted", "applied", "synced"]);
        assert_eq!(
            changes[1].get("resource").and_then(|r| r.get("name")),
            Some(&serde_json::json!("api-0")),
        );
    }

    /// The frontend switches on `kind` as a bare lowercase string
    /// (`"gone"` / `"broken"`); serde's default would emit `"Gone"` and
    /// every comparison would silently fall through to the retry path.
    #[test]
    fn stream_failed_payload_carries_id_kind_and_message() {
        let payload = AppEvent::StreamFailed {
            stream_id: "log-7".into(),
            kind: StreamFailureKind::Gone,
            message: "default/api-0 stopped streaming".into(),
        }
        .payload();

        assert_eq!(
            payload.get("stream_id").and_then(|v| v.as_str()),
            Some("log-7")
        );
        assert_eq!(payload.get("kind").and_then(|v| v.as_str()), Some("gone"));
        assert_eq!(
            payload.get("message").and_then(|v| v.as_str()),
            Some("default/api-0 stopped streaming"),
        );

        let broken = AppEvent::StreamFailed {
            stream_id: "term-7".into(),
            kind: StreamFailureKind::Broken,
            message: "upgrade rejected".into(),
        }
        .payload();
        assert_eq!(broken.get("kind").and_then(|v| v.as_str()), Some("broken"));
    }

    /// A cluster that failed and a cluster that matched nothing both
    /// end a search with zero hits. The payload has to keep them
    /// apart, or the palette repeats the "No output yet" lie one more
    /// time — this time for a whole cluster.
    #[test]
    fn search_status_payload_separates_a_failure_from_an_empty_result() {
        use crate::search::{SearchContextStatus, SearchFailureKind};

        let empty = AppEvent::SearchStatus {
            search_id: "s-1".into(),
            context: "dev".into(),
            status: SearchContextStatus::Done,
            reason: None,
            message: None,
            matched: 0,
            truncated: false,
        }
        .payload();
        assert_eq!(empty.get("status").and_then(|v| v.as_str()), Some("done"));
        assert!(empty.get("reason").is_some_and(serde_json::Value::is_null));

        let failed = AppEvent::SearchStatus {
            search_id: "s-1".into(),
            context: "prod".into(),
            status: SearchContextStatus::Failed,
            reason: Some(SearchFailureKind::Unreachable),
            message: Some("connection refused".into()),
            matched: 0,
            truncated: false,
        }
        .payload();
        assert_eq!(
            failed.get("status").and_then(|v| v.as_str()),
            Some("failed")
        );
        assert_eq!(
            failed.get("reason").and_then(|v| v.as_str()),
            Some("unreachable"),
            "the frontend switches on kebab-case reasons"
        );
        assert_eq!(
            failed.get("message").and_then(|v| v.as_str()),
            Some("connection refused"),
        );

        let skipped = AppEvent::SearchStatus {
            search_id: "s-1".into(),
            context: "stage".into(),
            status: SearchContextStatus::Skipped,
            reason: Some(SearchFailureKind::NotConnected),
            message: Some("not connected".into()),
            matched: 0,
            truncated: false,
        }
        .payload();
        assert_eq!(
            skipped.get("reason").and_then(|v| v.as_str()),
            Some("not-connected"),
        );
    }

    #[test]
    fn classify_separates_a_missing_resource_from_a_broken_connection() {
        use crate::error::Error;

        assert_eq!(
            StreamFailureKind::classify(&Error::NotFound {
                kind: "Pod".into(),
                name: "api-0".into(),
                namespace: "default".into(),
            }),
            StreamFailureKind::Gone,
        );
        assert_eq!(
            StreamFailureKind::classify(&Error::LogStream(
                "Failed to start log stream: ApiError: pods \"api-0\" not found: NotFound".into()
            )),
            StreamFailureKind::Gone,
        );
        // The k3d reproduction: exec answers the upgrade with a 500.
        // Nothing about that says the pod is gone.
        assert_eq!(
            StreamFailureKind::classify(&Error::Terminal(
                "Failed to exec: failed to upgrade to a WebSocket connection: 500".into()
            )),
            StreamFailureKind::Broken,
        );
    }

    /// A container that has never restarted has no previous run, and
    /// the apiserver says so in a sentence ending "not found". Read by
    /// the generic rule that would be `Gone` — the pod announced as
    /// deleted while it sits in the list, running.
    #[test]
    fn classify_separates_a_missing_previous_run_from_a_missing_pod() {
        use crate::error::Error;

        // Verbatim from k3d, `kubectl logs init-demo -c wait-for-db --previous`.
        let apiserver = "Failed to start log stream: ApiError: previous terminated \
                         container \"wait-for-db\" in pod \"init-demo\" not found: BadRequest";
        assert_eq!(
            StreamFailureKind::classify(&Error::LogStream(apiserver.into())),
            StreamFailureKind::NoPreviousRun,
        );
        assert_eq!(
            StreamFailureKind::classify(&Error::NoPreviousRun {
                container: "wait-for-db".into()
            }),
            StreamFailureKind::NoPreviousRun,
        );
        // And the real disappearance still reads as one.
        assert_eq!(
            StreamFailureKind::classify(&Error::LogStream(
                "Failed to start log stream: ApiError: pods \"init-demo\" not found: NotFound"
                    .into()
            )),
            StreamFailureKind::Gone,
        );
    }

    /// The frontend switches on the bare string. `lowercase` would have
    /// emitted `nopreviousrun`.
    #[test]
    fn stream_failure_kinds_serialize_kebab_case() {
        let kinds = [
            (StreamFailureKind::Gone, "gone"),
            (StreamFailureKind::Broken, "broken"),
            (StreamFailureKind::NoPreviousRun, "no-previous-run"),
        ];
        for (kind, expected) in kinds {
            assert_eq!(serde_json::to_value(kind).unwrap(), expected);
        }
    }

    #[test]
    fn readable_cause_strips_stacked_wrapper_prefixes() {
        use crate::error::Error;

        assert_eq!(
            readable_cause(&Error::Terminal(
                "Failed to exec: failed to upgrade to a WebSocket connection: 500".into()
            )),
            "failed to upgrade to a WebSocket connection: 500",
        );
        assert_eq!(
            readable_cause(&Error::LogStream(
                "Failed to start log stream: connection refused".into()
            )),
            "connection refused",
        );
        // Nothing to peel: the text survives intact.
        assert_eq!(
            readable_cause(&Error::Connection("kube-apiserver unreachable".into())),
            "kube-apiserver unreachable",
        );
    }
}
