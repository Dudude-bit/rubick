//! Log streaming commands

use crate::error::{Error, Result};
use crate::logs::{LogConfig, LogLine, LogStreamer};
use crate::state::{AppState, LogStream};
use crate::utils::normalize_optional_namespace;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use tokio::sync::oneshot;

/// How many lines to read when the caller does not say.
///
/// One concept, one answer: `stream_pod_logs` used to default to 100 and
/// `get_pod_logs` to 1000, so the same request answered two different
/// ways depending on which command served it. The viewer always sends an
/// explicit value now — this is what everything else gets.
pub const DEFAULT_TAIL_LINES: i64 = 1000;

/// The one place the default is applied.
fn tail_or_default(tail_lines: Option<i64>) -> i64 {
    tail_lines.unwrap_or(DEFAULT_TAIL_LINES)
}

/// RAII guard that removes a log stream's entry from the global map
/// when dropped — including on panic-unwind inside the spawned task.
/// Without this, a panicking `streamer.stream_logs(...)` call leaves a
/// zombie entry in `state.log_streams` forever, and the natural Ok/Err
/// return path also leaks because the frontend has no way to know the
/// stream ended without an explicit notification.
struct LogStreamCleanup {
    map: Arc<DashMap<String, LogStream>>,
    key: String,
}

impl Drop for LogStreamCleanup {
    fn drop(&mut self) {
        self.map.remove(&self.key);
    }
}

/// Log stream configuration from frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamLogConfig {
    pub pod_name: String,
    pub namespace: Option<String>,
    pub container: Option<String>,
    pub follow: bool,
    pub tail_lines: Option<i64>,
    pub since_seconds: Option<i64>,
    pub timestamps: bool,
    pub previous: bool,
}

/// Start streaming logs from a pod
#[tauri::command]
pub async fn stream_pod_logs(
    config: StreamLogConfig,
    state: State<'_, AppState>,
) -> Result<String> {
    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;

    let client = state
        .client_manager
        .get_client(&context)
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLIENT.to_string()))?;

    let namespace = normalize_optional_namespace(config.namespace.clone())
        .unwrap_or_else(|| "default".to_string());

    let mut log_config = LogConfig::new(&config.pod_name, &namespace)
        .with_follow(config.follow)
        .with_tail(tail_or_default(config.tail_lines))
        .with_timestamps(config.timestamps)
        .with_previous(config.previous);

    if let Some(since_seconds) = config.since_seconds {
        log_config = log_config.with_since_seconds(since_seconds);
    }

    if let Some(ref container) = config.container {
        log_config = log_config.with_container(container);
    }

    let stream_id = crate::utils::generate_id("log");
    let event_tx = state.event_tx.clone();

    let streamer = LogStreamer::new(Arc::new((*client).clone()), event_tx);

    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let (subscribe_tx, subscribe_rx) = oneshot::channel::<()>();
    let stream_id_clone = stream_id.clone();
    let log_streams = state.log_streams.clone();

    // Store the log stream info
    let log_stream = LogStream {
        id: stream_id.clone(),
        pod: config.pod_name.clone(),
        container: config.container.unwrap_or_default(),
        namespace: namespace.clone(),
        cancel_tx,
        subscribe_tx: Some(subscribe_tx),
    };
    state.log_streams.insert(stream_id.clone(), log_stream);

    // Spawn background task to stream logs.
    //
    // `streamer.stream_logs(...)` IS the read+emit loop, so the gate
    // covers the entire call. Without it, log-batch events emitted
    // between this command returning and the frontend's `listen()`
    // installing are dropped — same race that bit the terminal-auth
    // modal. The RAII cleanup guard handles entry removal on every
    // exit path: explicit cancel, natural Ok/Err return, and panic
    // unwind. The `stop_log_stream` command remains a no-op on the
    // already-removed entry in those cases.
    tokio::spawn(async move {
        let _cleanup = LogStreamCleanup {
            map: log_streams,
            key: stream_id_clone.clone(),
        };

        tokio::select! {
            _ = subscribe_rx => {}
            _ = &mut cancel_rx => {
                tracing::debug!("Log stream {} cancelled before subscribe", stream_id_clone);
                return;
            }
            _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                tracing::warn!(
                    "Log stream {} subscribe gate timed out after 60s; \
                     starting stream anyway",
                    stream_id_clone
                );
            }
        }

        if let Err(e) = streamer
            .stream_logs(stream_id_clone.clone(), log_config, cancel_rx)
            .await
        {
            tracing::error!("Log stream {} error: {}", stream_id_clone, e);
        }
    });

    Ok(stream_id)
}

/// Signal that the frontend has registered its `log-batch` listener and
/// is ready to receive events. The backend stream task blocks until
/// this is called. Idempotent — calling twice is a no-op. Errors only
/// on unknown stream IDs so a malicious caller cannot release arbitrary
/// streams.
#[tauri::command]
pub fn log_stream_subscribed(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some(mut entry) = state.log_streams.get_mut(&stream_id) {
        if let Some(tx) = entry.subscribe_tx.take() {
            // Receiver may already have been dropped (stream cancelled
            // during startup). That's fine — nothing to release.
            let _ = tx.send(());
        }
        Ok(())
    } else {
        Err(Error::Internal(format!("Log stream {stream_id} not found")))
    }
}

/// Get pod logs (non-streaming, returns all at once)
#[tauri::command]
pub async fn get_pod_logs(
    pod_name: String,
    namespace: Option<String>,
    container: Option<String>,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    previous: bool,
    state: State<'_, AppState>,
) -> Result<Vec<LogLine>> {
    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;

    let client = state
        .client_manager
        .get_client(&context)
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLIENT.to_string()))?;

    let namespace =
        normalize_optional_namespace(namespace).unwrap_or_else(|| "default".to_string());

    let mut log_config = LogConfig::new(&pod_name, &namespace)
        .with_follow(false)
        .with_tail(tail_or_default(tail_lines))
        .with_previous(previous);

    if let Some(since_seconds) = since_seconds {
        log_config = log_config.with_since_seconds(since_seconds);
    }

    if let Some(container) = container {
        log_config = log_config.with_container(&container);
    }

    let event_tx = state.event_tx.clone();
    let streamer = LogStreamer::new(Arc::new((*client).clone()), event_tx);
    let logs = streamer.get_logs(&log_config).await?;

    Ok(logs)
}

/// Stop log streaming
#[tauri::command]
pub fn stop_log_stream(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some((_, log_stream)) = state.log_streams.remove(&stream_id) {
        let _ = log_stream.cancel_tx.send(());
        tracing::info!("Log stream {} stopped", stream_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_log_stream(id: &str) -> LogStream {
        let (cancel_tx, _cancel_rx) = oneshot::channel::<()>();
        let (subscribe_tx, _subscribe_rx) = oneshot::channel::<()>();
        LogStream {
            id: id.to_string(),
            pod: "p".to_string(),
            container: "c".to_string(),
            namespace: "n".to_string(),
            cancel_tx,
            subscribe_tx: Some(subscribe_tx),
        }
    }

    #[test]
    fn both_log_commands_default_to_the_same_tail() {
        // The regression this guards: `stream_pod_logs` defaulted to 100
        // and `get_pod_logs` to 1000, so "how many lines" had two
        // answers depending on which command you asked.
        assert_eq!(tail_or_default(None), DEFAULT_TAIL_LINES);
        assert_eq!(tail_or_default(Some(42)), 42);
    }

    #[test]
    fn cleanup_guard_removes_entry_on_drop() {
        let map: Arc<DashMap<String, LogStream>> = Arc::new(DashMap::new());
        map.insert("k".to_string(), make_test_log_stream("k"));
        assert_eq!(map.len(), 1);

        {
            let _guard = LogStreamCleanup {
                map: map.clone(),
                key: "k".to_string(),
            };
        }

        assert_eq!(
            map.len(),
            0,
            "guard's Drop must remove the entry — same path runs on panic-unwind in tokio::spawn"
        );
    }

    #[test]
    fn cleanup_guard_drop_is_safe_when_entry_already_removed() {
        // Race: stop_log_stream removes the entry while the spawn task
        // is still running. The guard's Drop must not panic when the
        // key is no longer in the map.
        let map: Arc<DashMap<String, LogStream>> = Arc::new(DashMap::new());
        let guard = LogStreamCleanup {
            map: map.clone(),
            key: "missing".to_string(),
        };
        drop(guard); // must not panic
        assert_eq!(map.len(), 0);
    }
}
