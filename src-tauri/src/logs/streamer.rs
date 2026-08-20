//! `LogStreamer` — owns a kube `Client` and an event broadcaster,
//! exposes `get_logs` (one-shot) and `stream_logs` (with batching
//! and a periodic flush, so verbose pods don't generate one Tauri
//! round-trip per line).

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::state::{
    is_missing_previous_run, readable_cause, AppEvent, LogLineEvent, StreamFailureKind,
};
use chrono::Utc;
use k8s_openapi::api::core::v1::Pod;
use kube::{api::Api, Client};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{broadcast, oneshot};
use tokio::time::{interval, MissedTickBehavior};

use super::config::LogConfig;
use super::filter::IntakeFilter;
use super::parser;
use super::types::LogLine;

/// Maximum log lines buffered before forcing a flush, regardless of
/// the timer. Prevents a burst of fast-emitting log output from
/// growing the buffer unbounded between ticks.
const MAX_BATCH_SIZE: usize = 100;

/// Flush interval. 50ms keeps perceived latency low (~one frame at
/// 20fps) while collapsing 100+ events/sec verbose-pod streams into
/// ~20 events/sec of Tauri round-trips.
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// Streams logs from a pod, batches lines, emits `AppEvent::LogBatch`.
pub struct LogStreamer {
    client: Arc<Client>,
    event_tx: broadcast::Sender<AppEvent>,
}

impl LogStreamer {
    #[must_use]
    pub fn new(client: Arc<Client>, event_tx: broadcast::Sender<AppEvent>) -> Self {
        Self { client, event_tx }
    }

    /// One-shot: fetch logs and return them parsed. Forces
    /// `follow = false` regardless of `config.follow`.
    pub async fn get_logs(&self, config: &LogConfig) -> Result<Vec<LogLine>> {
        let ctx = ResourceContext::from_client((*self.client).clone(), config.namespace.clone());
        let api: Api<Pod> = ctx.namespaced_api();

        let mut params = config.to_log_params();
        params.follow = false;

        let container = config
            .container
            .clone()
            .unwrap_or_else(|| "main".to_string());

        let logs = api
            .logs(&config.pod, &params)
            .await
            .map_err(|e| log_error(&e.to_string(), &container, "Failed to get logs"))?;

        Ok(parser::parse_logs(
            &logs,
            &config.pod,
            &container,
            &config.namespace,
        ))
    }

    /// Streaming follow loop. Buffers lines and flushes every
    /// `FLUSH_INTERVAL` (or sooner if the buffer fills) so verbose
    /// pods don't generate one Tauri round-trip per line.
    pub async fn stream_logs(
        &self,
        stream_id: String,
        config: LogConfig,
        mut cancel_rx: oneshot::Receiver<()>,
    ) -> Result<()> {
        let ctx = ResourceContext::from_client((*self.client).clone(), config.namespace.clone());
        let api: Api<Pod> = ctx.namespaced_api();
        let params = config.to_log_params();

        let container = config
            .container
            .clone()
            .unwrap_or_else(|| "main".to_string());
        let pod = config.pod.clone();
        let namespace = config.namespace.clone();

        let target = format!("{namespace}/{pod}");

        // Kubernetes has no grep, so this is the only place a line can
        // be dropped before anything downstream pays for it: no event,
        // no IPC hop, no slot in the retained buffer. Measured on
        // `flood-demo`, that is the difference between 5 000 lines
        // covering 24 seconds and the same 5 000 covering 3m 23s.
        let intake = IntakeFilter::new(&config.intake);
        // Where the stream last was on the clock. Lines the container
        // wrote without a timestamp inherit it — kept or discarded, they
        // all move it — which is how the viewer places them too.
        let mut epoch_ms = Utc::now().timestamp_millis();

        let stream = match api.log_stream(&config.pod, &params).await {
            Ok(stream) => stream,
            Err(e) => {
                let error = log_error(&e.to_string(), &container, "Failed to start log stream");
                let cause = readable_cause(&error);
                let kind = StreamFailureKind::classify(&error);
                emit_failure(
                    &self.event_tx,
                    &stream_id,
                    kind,
                    match kind {
                        StreamFailureKind::Gone => {
                            format!("Pod {target} is not there any more — {cause}.")
                        }
                        StreamFailureKind::Broken => {
                            format!("Could not attach to the logs of {target} — {cause}.")
                        }
                        StreamFailureKind::NoPreviousRun => format!(
                            "There is no previous run of {container} to show — \
                             it has not restarted since {target} started."
                        ),
                    },
                );
                return Err(error);
            }
        };

        use tokio_util::compat::FuturesAsyncReadCompatExt;
        let reader = BufReader::new(stream.compat());
        let mut lines = reader.lines();

        // Buffer + periodic flush. Triggers: timer tick, buffer hits
        // MAX_BATCH_SIZE, cancel, or EOF.
        let mut buffer: Vec<LogLineEvent> = Vec::with_capacity(MAX_BATCH_SIZE);
        let mut ended_because_gone = false;
        let mut flush_timer = interval(FLUSH_INTERVAL);
        // First tick fires immediately; skip it so an empty buffer
        // doesn't emit an empty batch right after subscribe.
        flush_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
        flush_timer.tick().await;

        loop {
            tokio::select! {
                biased;
                _ = &mut cancel_rx => {
                    tracing::debug!("Log stream {} cancelled", stream_id);
                    break;
                }
                _ = flush_timer.tick() => {
                    if !buffer.is_empty() {
                        flush_batch(&self.event_tx, &stream_id, &mut buffer);
                    }
                }
                result = lines.next_line() => {
                    match result {
                        Ok(Some(line)) => {
                            let log_line = parser::parse_log_line(
                                &line,
                                &pod,
                                &container,
                                &namespace,
                            );

                            if let Some(ts) = log_line.timestamp {
                                epoch_ms = ts.timestamp_millis();
                            }

                            if intake.matches(&log_line, epoch_ms) {
                                buffer.push(LogLineEvent {
                                    message: log_line.message,
                                    timestamp: log_line.timestamp.map(|t| t.to_rfc3339()),
                                    level: log_line.level,
                                    format: log_line.format,
                                    fields: log_line.fields,
                                    raw: log_line.raw,
                                });

                                if buffer.len() >= MAX_BATCH_SIZE {
                                    flush_batch(&self.event_tx, &stream_id, &mut buffer);
                                }
                            }
                        }
                        Ok(None) => {
                            tracing::debug!("Log stream {} reached EOF", stream_id);
                            // Following a live pod, the apiserver only
                            // closes the body when there is nothing
                            // left to follow: the pod was deleted or
                            // the container exited. Silence here is
                            // what made a deleted pod read as "No
                            // output yet". A one-shot read ending is
                            // just the read finishing, so say nothing —
                            // and so is a previous run, which is
                            // complete before it is asked for and ends
                            // the moment it has been handed over.
                            if config.follow && !config.previous {
                                ended_because_gone = true;
                            }
                            break;
                        }
                        Err(e) => {
                            tracing::error!("Log stream {} read error: {}", stream_id, e);
                            let error = Error::LogStream(format!("Log stream read failed: {e}"));
                            emit_failure(
                                &self.event_tx,
                                &stream_id,
                                StreamFailureKind::Broken,
                                format!(
                                    "The log stream from {target} broke — {}.",
                                    readable_cause(&error)
                                ),
                            );
                            break;
                        }
                    }
                }
            }
        }

        // Final flush on exit so trailing lines don't get dropped —
        // and it has to land before the failure, or the panel replaces
        // the last lines the pod ever wrote with an error.
        if !buffer.is_empty() {
            flush_batch(&self.event_tx, &stream_id, &mut buffer);
        }

        if ended_because_gone {
            emit_failure(
                &self.event_tx,
                &stream_id,
                StreamFailureKind::Gone,
                format!("{target} stopped streaming — container {container} is no longer running."),
            );
        }

        Ok(())
    }
}

/// Wrap an apiserver log failure, keeping "there is no previous run"
/// separate from "the read failed".
///
/// Both arrive as the same `kube::Error` and the apiserver's text for
/// the first ends in "not found", so flattening them into one
/// `LogStream` string is what made a container that has simply never
/// restarted indistinguishable from a pod that has been deleted.
fn log_error(cause: &str, container: &str, context: &str) -> Error {
    if is_missing_previous_run(cause) {
        return Error::NoPreviousRun {
            container: container.to_string(),
        };
    }
    Error::LogStream(format!("{context}: {cause}"))
}

/// Tell the frontend a stream stopped on its own. Send failures are
/// ignored for the same reason as everywhere else here: no receiver
/// means no window left to inform.
fn emit_failure(
    event_tx: &broadcast::Sender<AppEvent>,
    stream_id: &str,
    kind: StreamFailureKind,
    message: String,
) {
    let _ = event_tx.send(AppEvent::StreamFailed {
        stream_id: stream_id.to_string(),
        kind,
        message,
    });
}

/// Drain the per-stream buffer into a single `AppEvent::LogBatch`.
/// Caller guarantees the buffer is non-empty.
fn flush_batch(
    event_tx: &broadcast::Sender<AppEvent>,
    stream_id: &str,
    buffer: &mut Vec<LogLineEvent>,
) {
    let lines = std::mem::take(buffer);
    let _ = event_tx.send(AppEvent::LogBatch {
        stream_id: stream_id.to_string(),
        lines,
    });
}
