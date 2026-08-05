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
    /// Watcher restarted (resync) — frontend should clear its cache
    /// before the burst of `applied` events that follows.
    Restarted,
    /// Watch failed N times in a row without recovery (typically RBAC
    /// `watch` verb missing, or kube-apiserver unreachable). The
    /// frontend should fall back to periodic refresh and tell the
    /// user. The watcher task keeps retrying in the background; if
    /// it eventually recovers, an `applied`/`restarted` resets the
    /// state and a fresh `failed` would only be emitted after another
    /// streak of errors.
    Failed,
}

/// Events that can be broadcast to frontend
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum AppEvent {
    /// Resource was created
    ResourceCreated {
        kind: String,
        name: String,
        namespace: String,
    },
    /// Resource was updated
    ResourceUpdated {
        kind: String,
        name: String,
        namespace: String,
    },
    /// Resource was deleted
    ResourceDeleted {
        kind: String,
        name: String,
        namespace: String,
    },
    /// Connection status changed
    ConnectionStatusChanged { context: String, connected: bool },
    /// Batch of log lines for a single stream. The streamer flushes
    /// every ~50ms (or sooner if the buffer fills) so that verbose
    /// pods don't generate one Tauri round-trip per line. Always
    /// non-empty.
    LogBatch {
        stream_id: String,
        lines: Vec<LogLineEvent>,
    },
    /// One Kubernetes watch event for a resource of a known kind.
    /// Forwarded to the frontend so it can update the TanStack Query
    /// cache directly, replacing the old 2s polling refresh model.
    /// The `resource` JSON is the typed resource serialized via
    /// the same path the existing list/get commands use.
    ResourceWatchEvent {
        stream_id: String,
        op: WatchOp,
        /// Set on `applied`/`deleted`. None on `restarted` resyncs
        /// and on `failed` events.
        resource: Option<serde_json::Value>,
        /// Set on `failed` events with the error string (RBAC
        /// denial, network error, etc.). None for every other op.
        error: Option<String>,
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
            AppEvent::ResourceWatchEvent { .. } => "resource-event",
            AppEvent::TerminalOutput { .. } => "terminal-output",
            AppEvent::TerminalClosed { .. } => "terminal-closed",
            AppEvent::PortForwardStatus { .. } => "port-forward-status",
            AppEvent::ConnectionStatusChanged { .. } => "connection-status",
            AppEvent::AuthUrlRequested { .. } => "auth-url-requested",
            AppEvent::AuthFlowCompleted { .. } => "auth-flow-completed",
            AppEvent::AuthFlowCancelled { .. } => "auth-flow-cancelled",
            AppEvent::AuthTerminalSessionCreated { .. } => "auth-terminal-session-created",
            AppEvent::ResourceCreated { .. } => "resource-created",
            AppEvent::ResourceUpdated { .. } => "resource-updated",
            AppEvent::ResourceDeleted { .. } => "resource-deleted",
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
            AppEvent::ResourceWatchEvent {
                stream_id,
                op,
                resource,
                error,
            } => serde_json::json!({
                "stream_id": stream_id,
                "op": op,
                "resource": resource,
                "error": error,
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
            AppEvent::ConnectionStatusChanged { context, connected } => serde_json::json!({
                "context": context,
                "connected": connected,
            }),
            AppEvent::AuthUrlRequested {
                context,
                url,
                flow,
                session_id,
            } => serde_json::json!({
                "context": context,
                "url": url,
                "flow": flow,
                "session_id": session_id,
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
            AppEvent::ResourceCreated {
                kind,
                name,
                namespace,
            }
            | AppEvent::ResourceUpdated {
                kind,
                name,
                namespace,
            }
            | AppEvent::ResourceDeleted {
                kind,
                name,
                namespace,
            } => serde_json::json!({
                "kind": kind,
                "name": name,
                "namespace": namespace,
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
                context: "infra-nbg4".into(),
                command: "kubectl oidc-login".into(),
            },
            AppEvent::AuthUrlRequested {
                context: "infra-nbg4".into(),
                url: "https://example".into(),
                flow: "exec".into(),
                session_id: Some("auth-1".into()),
            },
            AppEvent::AuthFlowCompleted {
                session_id: "auth-1".into(),
                context: "infra-nbg4".into(),
                success: true,
                message: None,
            },
            AppEvent::ConnectionStatusChanged {
                context: "minikube".into(),
                connected: true,
            },
            AppEvent::ResourceCreated {
                kind: "Pod".into(),
                name: "p".into(),
                namespace: "default".into(),
            },
            AppEvent::Error {
                code: "X".into(),
                message: "y".into(),
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
            context: "infra-nbg4".into(),
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
            Some("infra-nbg4"),
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
                },
                "auth-url-requested",
            ),
        ];

        for (event, expected) in cases {
            assert_eq!(event.channel(), expected);
        }
    }
}
