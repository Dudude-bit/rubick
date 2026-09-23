//! Log streaming commands

use crate::error::{Error, Result};
use crate::logs::{LogConfig, LogLine, LogStreamer, QueryTerm};
use crate::state::streams::SUBSCRIBE_TIMEOUT;
use crate::state::AppState;
use crate::utils::normalize_optional_namespace;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

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
    /// An instant to start from, which is how a stream is restarted
    /// without repeating itself: `sinceTime` set to the last line the
    /// caller holds and `tailLines: 0` continues where its buffer ends.
    /// Changing intake is exactly that restart, and nothing here treats
    /// the lines already held as invalid — no event says they were, and
    /// stopping a stream is silent.
    pub since_time: Option<DateTime<Utc>>,
    pub timestamps: bool,
    pub previous: bool,
    /// Terms every arriving line must satisfy to be kept. Empty keeps
    /// everything.
    #[serde(default)]
    pub intake: Vec<QueryTerm>,
}

/// Start streaming logs from a pod
#[tauri::command]
pub async fn stream_pod_logs(
    config: StreamLogConfig,
    state: State<'_, AppState>,
) -> Result<String> {
    let client = state.current_client()?;

    let namespace = normalize_optional_namespace(config.namespace.clone())
        .unwrap_or_else(|| "default".to_string());

    let mut log_config = LogConfig::new(&config.pod_name, &namespace)
        .with_follow(config.follow)
        .with_tail(tail_or_default(config.tail_lines))
        .with_timestamps(config.timestamps)
        .with_previous(config.previous)
        .with_intake(config.intake);

    if let Some(since_seconds) = config.since_seconds {
        log_config = log_config.with_since_seconds(since_seconds);
    }

    if let Some(since_time) = config.since_time {
        log_config = log_config.with_since_time(since_time);
    }

    if let Some(ref container) = config.container {
        log_config = log_config.with_container(container);
    }

    let stream_id = crate::utils::generate_id("log");
    let event_tx = state.event_tx.clone();

    let streamer = LogStreamer::new(Arc::new((*client).clone()), event_tx);

    let mut opened = state.log_streams.open(stream_id.clone());

    // `streamer.stream_logs(...)` IS the read+emit loop, so the gate covers
    // the entire call: log-batch events emitted before the frontend's
    // `listen()` is installed are dropped. The entry leaves with the task,
    // so `stop_log_stream` is a no-op on a stream that already ended.
    tokio::spawn(async move {
        if !opened.wait_for_subscriber(SUBSCRIBE_TIMEOUT).await {
            tracing::debug!("Log stream {} stopped before subscribe", opened.id);
            return;
        }
        let id = opened.id.clone();
        let (cancel, _held) = opened.split();
        if let Err(e) = streamer.stream_logs(id.clone(), log_config, cancel).await {
            tracing::error!("Log stream {} error: {}", id, e);
        }
    });

    Ok(stream_id)
}

/// Signal that the frontend has registered its `log-batch` listener and
/// is ready to receive events. The backend stream task blocks until
/// this is called. Idempotent — calling twice is a no-op, and so is
/// calling it for a stream that is already gone: the caller lost a race
/// with its own stop, and there is no gate left to release. It used to
/// be an error, which turned every coalesced restart into a failure the
/// viewer had to be taught to ignore.
#[tauri::command]
pub fn log_stream_subscribed(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    if !state.log_streams.subscribed(&stream_id) {
        tracing::debug!("Log stream {} subscribed after it ended", stream_id);
    }
    Ok(())
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
    let client = state.current_client()?;

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

/// Save a container's log into the Downloads folder, and say where.
///
/// Written here rather than handed to the webview to write: ten thousand
/// parsed lines, about six fields each, made one IPC answer of well over a
/// megabyte for a file that needs only the text of each line.
#[tauri::command]
pub async fn save_pod_log(
    pod_name: String,
    namespace: Option<String>,
    container: String,
    tail_lines: Option<i64>,
    previous: bool,
    state: State<'_, AppState>,
) -> Result<String> {
    // Both names become the file's name: validated, nothing in them can
    // reach outside the folder.
    crate::validation::validate_name::<k8s_openapi::api::core::v1::Pod>(&pod_name)?;
    crate::validation::validate_dns_label(&container)?;
    let lines = get_pod_logs(
        pod_name.clone(),
        namespace,
        Some(container.clone()),
        tail_lines,
        None,
        previous,
        state,
    )
    .await?;
    let dir = dirs::download_dir()
        .ok_or_else(|| Error::Config("There is no Downloads folder to save into".to_string()))?;
    let stem = format!(
        "{pod_name}-{container}{}",
        if previous { "-previous" } else { "" }
    );
    let path = crate::logs::text::unused_path(&dir, &stem, "log");
    tokio::fs::write(&path, crate::logs::text::log_text(&lines)).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Stop log streaming
#[tauri::command]
pub fn stop_log_stream(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    if state.log_streams.stop(&stream_id) {
        tracing::info!("Log stream {} stopped", stream_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_log_commands_default_to_the_same_tail() {
        // The regression this guards: `stream_pod_logs` defaulted to 100
        // and `get_pod_logs` to 1000, so "how many lines" had two
        // answers depending on which command you asked.
        assert_eq!(tail_or_default(None), DEFAULT_TAIL_LINES);
        assert_eq!(tail_or_default(Some(42)), 42);
    }
}
