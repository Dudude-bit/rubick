//! `LogStreamer` — owns a kube `Client` and an event broadcaster,
//! exposes `get_logs` (one-shot) and `stream_logs` (with batching
//! and a periodic flush, so verbose pods don't generate one Tauri
//! round-trip per line).

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, KubeErrorExt, Result};
use crate::state::perf::{wire_len, IPC_TARGET_BYTES};
use crate::state::{
    is_missing_previous_run, is_runtime_dropped_log, readable_cause, AppEvent, LogLineEvent,
    StreamFailureKind,
};
use crate::utils::Moment;
use chrono::{DateTime, Utc};
use futures::AsyncReadExt;
use k8s_openapi::api::core::v1::Pod;
use kube::{api::Api, Client};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::sync::broadcast;
use tokio::time::{interval, MissedTickBehavior};
use tokio_util::compat::FuturesAsyncReadCompatExt;
use tracing::Level;

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

/// How long the pod's status may lag a follow the kubelet closed because
/// the container exited, and how many times it is read again meanwhile.
const STATUS_SETTLE: Duration = Duration::from_secs(1);
const STATUS_READS: usize = 3;

type FreshClient = Arc<dyn Fn() -> Result<Arc<Client>> + Send + Sync>;

/// Streams logs from a pod, batches lines, emits `AppEvent::LogBatch`.
pub struct LogStreamer {
    client: Arc<Client>,
    event_tx: broadcast::Sender<AppEvent>,
    /// The client a follow that ended reads the pod with, taken then: the
    /// stream may have been open for hours on a token that has expired.
    fresh: FreshClient,
    settle: Duration,
}

impl LogStreamer {
    #[must_use]
    pub fn new(client: Arc<Client>, event_tx: broadcast::Sender<AppEvent>) -> Self {
        let held = client.clone();
        Self {
            client,
            event_tx,
            fresh: Arc::new(move || Ok(held.clone())),
            settle: STATUS_SETTLE,
        }
    }

    #[must_use]
    pub fn with_fresh_client(
        mut self,
        fresh: impl Fn() -> Result<Arc<Client>> + Send + Sync + 'static,
    ) -> Self {
        self.fresh = Arc::new(fresh);
        self
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

        // As bytes: `logs()` decodes the whole body at once and fails it on
        // the first byte that is not UTF-8, taking the history with it.
        let mut body = Vec::new();
        api.log_stream(&config.pod, &params)
            .await
            .map_err(|e| log_error(&e, &container, "Failed to get logs"))?
            .read_to_end(&mut body)
            .await
            .map_err(|e| Error::LogStream(format!("Log read failed: {e}")))?;
        let logs = String::from_utf8_lossy(&body);

        // A 200 whose body is the kubelet refusing; parsed, it is a fake line.
        if is_runtime_dropped_log(&logs) {
            return Err(Error::LogNotKept {
                container,
                said: logs.trim().to_string(),
            });
        }

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
        cancel: tokio_util::sync::CancellationToken,
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

        let opened_at = Utc::now();
        // After this the held client is a body being read, and the API
        // server does not re-check an admitted request's token, which is why
        // `useLogStream` does not restart on a renewal.
        let stream = match api.log_stream(&config.pod, &params).await {
            Ok(stream) => stream,
            Err(e) => {
                let error = log_error(&e, &container, "Failed to start log stream");
                match start_failure_level(&e) {
                    Level::INFO => tracing::info!("Log stream {stream_id} not started: {error}"),
                    Level::WARN => tracing::warn!("Log stream {stream_id} not started: {error}"),
                    _ => tracing::error!("Log stream {stream_id} not started: {error}"),
                }
                let cause = readable_cause(&error);
                let kind = StreamFailureKind::classify(&error);
                emit_failure(
                    &self.event_tx,
                    &stream_id,
                    kind,
                    match kind {
                        StreamFailureKind::Gone => {
                            format!("Pod {target} is not there any more: {cause}.")
                        }
                        // `classify` never answers the second: only a body
                        // that closed is read for it.
                        StreamFailureKind::Broken | StreamFailureKind::FollowStopped => {
                            format!("Could not attach to the logs of {target}: {cause}.")
                        }
                        StreamFailureKind::NoPreviousRun => format!(
                            "There is no previous run of {container} to show: \
                             it has not restarted since {target} started."
                        ),
                        StreamFailureKind::LogNotKept => format!(
                            "The node running {target} no longer has that log of \
                             {container}: {cause}."
                        ),
                    },
                );
                return Err(error);
            }
        };

        let mut reader = BufReader::new(stream.compat());
        let mut pending = Vec::new();
        let mut first = FirstLine::default();
        let following = config.follow && !config.previous;
        let mut words = NodeWords::new(following && config.timestamps);
        let mut refusal: Option<String> = None;
        let mut said: Option<String> = None;

        // Buffer + periodic flush. Triggers: timer tick, a full batch,
        // cancel, or EOF.
        let mut buffer = LineBatch::new(self.event_tx.clone(), stream_id.clone());
        let mut follow_ended = false;
        let mut flush_timer = interval(FLUSH_INTERVAL);
        // First tick fires immediately; skip it so an empty buffer
        // doesn't emit an empty batch right after subscribe.
        flush_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
        flush_timer.tick().await;

        loop {
            tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    tracing::debug!("Log stream {} cancelled", stream_id);
                    break;
                }
                _ = flush_timer.tick() => {
                    for line in first.expired().into_iter().flat_map(|line| words.arriving(line)) {
                        take_line(&line, &pod, &container, &namespace, &intake,
                                  &mut epoch_ms, &mut buffer);
                    }
                    buffer.flush();
                }
                result = next_line(&mut reader, &mut pending) => {
                    match result {
                        Ok(Some(line)) => {
                            for line in first.arriving(line).into_iter().flat_map(|line| words.arriving(line)) {
                                take_line(&line, &pod, &container, &namespace, &intake,
                                          &mut epoch_ms, &mut buffer);
                            }
                            if buffer.full() {
                                buffer.flush();
                            }
                        }
                        Ok(None) => {
                            tracing::debug!("Log stream {} reached EOF", stream_id);
                            // Nothing ever followed it: the body was the refusal.
                            refusal = first.ended();
                            said = words.ended();
                            if refusal.is_none() && said.as_deref().is_some_and(is_runtime_dropped_log) {
                                refusal = said.take();
                            }
                            // A followed body closes when the container
                            // exited, the pod was deleted, or the node gave
                            // up following; which one is read off the pod
                            // below. A one-shot read ending is the read
                            // finishing, and so is a previous run, complete
                            // before it is asked for.
                            follow_ended = following && refusal.is_none();
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
                                    "The log stream from {target} broke: {}.",
                                    readable_cause(&error)
                                ),
                            );
                            break;
                        }
                    }
                }
            }
        }

        // Cancelled or broken while a line was still held: it was output.
        for line in first.expired().into_iter().chain(words.released()) {
            take_line(
                &line,
                &pod,
                &container,
                &namespace,
                &intake,
                &mut epoch_ms,
                &mut buffer,
            );
        }

        // Final flush on exit so trailing lines don't get dropped —
        // and it has to land before the failure, or the panel replaces
        // the last lines the pod ever wrote with an error.
        buffer.flush();

        if let Some(said) = refusal {
            emit_failure(
                &self.event_tx,
                &stream_id,
                StreamFailureKind::LogNotKept,
                format!(
                    "The node running {target} no longer has that log of \
                     {container}: {said}."
                ),
            );
            return Ok(());
        }

        if follow_ended {
            let run = self
                .run_after_follow(
                    &namespace,
                    &pod,
                    &container,
                    opened_at,
                    said.is_none(),
                    &cancel,
                )
                .await;
            if let Some(run) = run {
                let (kind, message) = follow_end(run, said, &target, &container);
                emit_failure(&self.event_tx, &stream_id, kind, message);
            }
        }

        Ok(())
    }

    /// Where the followed run stands now, by the pod's own status. `None`
    /// when the stream was stopped meanwhile and nobody is listening.
    ///
    /// The kubelet closes a follow about a second after the container exits
    /// and the status can say so later still, so a clean close over a status
    /// that still says running is read again before it is believed. A close
    /// the node explained needs no second read.
    async fn run_after_follow(
        &self,
        namespace: &str,
        pod: &str,
        container: &str,
        opened_at: DateTime<Utc>,
        settle: bool,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Option<Run> {
        let reads = if settle { STATUS_READS } else { 1 };
        let mut run = Run::Unread(String::new());
        for read in 0..reads {
            if read > 0 {
                tokio::select! {
                    () = cancel.cancelled() => return None,
                    () = tokio::time::sleep(self.settle) => {}
                }
            }
            run = match (self.fresh)() {
                Ok(client) => {
                    let api: Api<Pod> = Api::namespaced((*client).clone(), namespace);
                    match api.get(pod).await {
                        Ok(found) => run_of(&found, container, opened_at),
                        Err(kube::Error::Api(status)) if status.code == 404 => {
                            Run::PodGone(status.message)
                        }
                        Err(e) => Run::Unread(e.display_clean()),
                    }
                }
                Err(e) => Run::Unread(readable_cause(&e)),
            };
            if run != Run::Same {
                break;
            }
        }
        (!cancel.is_cancelled()).then_some(run)
    }
}

/// The followed container's run, as the pod's status tells it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Run {
    /// Still running, and started before the follow opened.
    Same,
    /// Exited, waiting to start again, or running a later run.
    Over,
    /// The pod is not there any more, in the apiserver's words.
    PodGone(String),
    /// Could not tell, and why.
    Unread(String),
}

fn run_of(pod: &Pod, container: &str, opened_at: DateTime<Utc>) -> Run {
    let found = pod.status.as_ref().and_then(|status| {
        status
            .container_statuses
            .iter()
            .chain(&status.init_container_statuses)
            .chain(&status.ephemeral_container_statuses)
            .flatten()
            .find(|entry| entry.name == container)
    });
    let Some(state) = found.and_then(|entry| entry.state.as_ref()) else {
        return Run::Unread(format!("the pod's status says nothing of {container}"));
    };
    match &state.running {
        Some(running) => match &running.started_at {
            Some(at) if at.moment() > opened_at => Run::Over,
            _ => Run::Same,
        },
        None if state.terminated.is_some() || state.waiting.is_some() => Run::Over,
        None => Run::Unread(format!("the pod's status gives {container} no state")),
    }
}

/// How a follow that closed is reported, from where the run stands and
/// what the node said as it closed, if anything.
fn follow_end(
    run: Run,
    said: Option<String>,
    target: &str,
    container: &str,
) -> (StreamFailureKind, String) {
    match run {
        Run::Same => (StreamFailureKind::FollowStopped, said.unwrap_or_default()),
        Run::Over => (
            StreamFailureKind::Gone,
            format!("{target} stopped streaming: container {container} is no longer running."),
        ),
        Run::PodGone(cause) => (
            StreamFailureKind::Gone,
            format!("Pod {target} is not there any more: {cause}."),
        ),
        Run::Unread(cause) => (
            StreamFailureKind::Broken,
            match said {
                Some(said) => format!(
                    "The node stopped following {container} ({said}), and its state \
                     could not be read: {cause}."
                ),
                None => format!(
                    "The log stream from {target} closed, and the state of {container} \
                     could not be read: {cause}."
                ),
            },
        ),
    }
}

/// A line the node wrote into a followed stream, held until the stream
/// says whether it was the node's last word.
///
/// With timestamps on, every line a container wrote begins with one. A line
/// without is the kubelet's own, written as it gives up following
/// (`failed to create fsnotify watcher: too many open files`) right before
/// the body closes. Anything arriving after it proves it was output.
struct NodeWords {
    watching: bool,
    held: Option<String>,
}

impl NodeWords {
    fn new(watching: bool) -> Self {
        Self {
            watching,
            held: None,
        }
    }

    fn arriving(&mut self, line: String) -> Vec<String> {
        let mut out: Vec<String> = self.held.take().into_iter().collect();
        if self.watching && !stamped(&line) {
            self.held = Some(line);
        } else {
            out.push(line);
        }
        out
    }

    /// The body closed with it held: the node's words.
    fn ended(&mut self) -> Option<String> {
        self.held.take()
    }

    /// Cancelled or broken instead: it was output after all.
    fn released(&mut self) -> Option<String> {
        self.held.take()
    }
}

/// Starts with the RFC 3339 instant the kubelet prefixes when asked for
/// timestamps, whatever the length of the rest.
fn stamped(line: &str) -> bool {
    line.split_once(' ')
        .is_some_and(|(head, _)| DateTime::parse_from_rfc3339(head).is_ok())
}

/// The next line, whatever bytes the container wrote.
///
/// `lines()` ends the whole stream with `InvalidData` at the first byte that
/// is not UTF-8, and Reconnect then reads the same byte again; here it is a
/// U+FFFD in its own line. A line cut short by another `select!` branch keeps
/// its bytes in `pending` for the next call, as `read_until` promises.
async fn next_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    pending: &mut Vec<u8>,
) -> std::io::Result<Option<String>> {
    reader.read_until(b'\n', pending).await?;
    if pending.is_empty() {
        return Ok(None);
    }
    let mut end = pending.len();
    if pending.ends_with(b"\n") {
        end -= 1;
        if pending[..end].ends_with(b"\r") {
            end -= 1;
        }
    }
    let line = String::from_utf8_lossy(&pending[..end]).into_owned();
    pending.clear();
    Ok(Some(line))
}

/// The first line of a stream, held back while it could still be the
/// kubelet's refusal rather than output.
///
/// The kubelet answers a log the node no longer has with a 200 and that
/// sentence as the whole body, so only "one line and then the end" tells it
/// apart from a container that printed it. Nothing is held unless it is the
/// sentence itself, and never for longer than one flush interval.
#[derive(Default)]
struct FirstLine {
    held: Option<String>,
    seen: u64,
}

impl FirstLine {
    /// What this line releases as output: the held line first, where one is
    /// waiting, because something following it proves it was output.
    fn arriving(&mut self, line: String) -> Vec<String> {
        self.seen += 1;
        if self.seen == 1 && is_runtime_dropped_log(&line) {
            self.held = Some(line);
            return Vec::new();
        }
        match self.held.take() {
            Some(first) => vec![first, line],
            None => vec![line],
        }
    }

    /// The grace ran out, or the read was cancelled: it was output after all.
    fn expired(&mut self) -> Option<String> {
        self.held.take()
    }

    /// The stream ended with it still held, so the body was the refusal.
    fn ended(&mut self) -> Option<String> {
        self.held.take()
    }
}

/// One arriving line, parsed, clocked and kept if intake wants it.
fn take_line(
    line: &str,
    pod: &str,
    container: &str,
    namespace: &str,
    intake: &IntakeFilter,
    epoch_ms: &mut i64,
    buffer: &mut LineBatch,
) {
    let log_line = parser::parse_log_line(line, pod, container, namespace);
    if let Some(ts) = log_line.timestamp {
        *epoch_ms = ts.timestamp_millis();
    }
    if !intake.matches(&log_line, *epoch_ms) {
        return;
    }
    buffer.push(LogLineEvent {
        message: log_line.message,
        timestamp: log_line.timestamp.map(|t| t.to_rfc3339()),
        level: log_line.level,
        format: log_line.format,
        fields: log_line.fields,
        raw: log_line.raw,
        segments: log_line.segments,
    });
}

/// Wrap an apiserver log failure, keeping "there is no previous run"
/// separate from "the read failed".
///
/// Both arrive as the same `kube::Error` and the apiserver's text for
/// the first ends in "not found", so flattening them into one
/// `LogStream` string is what made a container that has simply never
/// restarted indistinguishable from a pod that has been deleted.
/// The server's answer about the container (waiting, gone, no previous run)
/// is a state the panel shows calmly, so the log does too; a refusal is a
/// warning, and only a stream that could not be asked is an error.
fn start_failure_level(error: &kube::Error) -> Level {
    match error {
        kube::Error::Api(status) if status.code == 403 || status.reason == "Forbidden" => {
            Level::WARN
        }
        kube::Error::Api(status) if (400..500).contains(&status.code) => Level::INFO,
        _ => Level::ERROR,
    }
}

fn log_error(error: &kube::Error, container: &str, context: &str) -> Error {
    let cause = error.display_clean();
    if is_missing_previous_run(&cause) {
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

/// The lines waiting for the next `AppEvent::LogBatch`, and what they come
/// to on the wire. A count alone let a hundred JSON lines with stack traces
/// leave as one event of several megabytes.
struct LineBatch {
    event_tx: broadcast::Sender<AppEvent>,
    stream_id: String,
    lines: Vec<LogLineEvent>,
    bytes: usize,
}

impl LineBatch {
    fn new(event_tx: broadcast::Sender<AppEvent>, stream_id: String) -> Self {
        Self {
            event_tx,
            stream_id,
            lines: Vec::with_capacity(MAX_BATCH_SIZE),
            bytes: 0,
        }
    }

    /// Sends what is held first when this line would take it past the
    /// budget; a line over the budget on its own still goes, alone.
    fn push(&mut self, line: LogLineEvent) {
        let bytes = wire_len(&line) + 1;
        if !self.lines.is_empty() && self.bytes + bytes > IPC_TARGET_BYTES {
            self.flush();
        }
        self.bytes += bytes;
        self.lines.push(line);
    }

    fn full(&self) -> bool {
        self.lines.len() >= MAX_BATCH_SIZE || self.bytes >= IPC_TARGET_BYTES
    }

    /// No-op when empty, so every exit path can call it.
    fn flush(&mut self) {
        if self.lines.is_empty() {
            return;
        }
        self.bytes = 0;
        let _ = self.event_tx.send(AppEvent::LogBatch {
            stream_id: self.stream_id.clone(),
            lines: std::mem::take(&mut self.lines),
        });
    }
}

#[cfg(test)]
mod log_error_tests {
    use super::*;

    /// Marco's log took an ERROR for the worker's logs while the container
    /// sat in `CreateContainerConfigError`, which the panel says calmly. Fails
    /// if the server's answer about the container is logged as an error.
    #[test]
    fn a_container_still_waiting_is_not_an_error_in_the_log() {
        let answer = |code: u16, reason: &str| {
            kube::Error::Api(Box::new(
                kube::core::Status::failure(
                    "container \"worker\" is waiting to start: CreateContainerConfigError",
                    reason,
                )
                .with_code(code),
            ))
        };
        assert_eq!(start_failure_level(&answer(400, "BadRequest")), Level::INFO);
        assert_eq!(start_failure_level(&answer(404, "NotFound")), Level::INFO);
        assert_eq!(start_failure_level(&answer(403, "Forbidden")), Level::WARN);
        assert_eq!(
            start_failure_level(&answer(502, "Failed to parse error data")),
            Level::ERROR
        );
        assert_eq!(
            start_failure_level(&kube::Error::Service("connection refused".into())),
            Level::ERROR
        );
    }

    /// The body the apiserver sends for the logs of a container stuck in
    /// `ImagePullBackOff`.
    const IMAGE_PULL_BACKOFF: &str = r#"{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"container \"app\" in pod \"payments-6d9d7d9db4-26vcv\" is waiting to start: trying and failing to pull image","reason":"BadRequest","code":400}"#;

    /// The payments pod's diagnosis card printed `Status { status:
    /// Some(Failure), code: 400, ... ListMeta { continue_: None ... } }`.
    /// Fails if a log failure carries kube's `Debug` dump of the status again.
    #[test]
    fn a_refused_log_read_says_the_server_message_and_no_status_dump() {
        let status: kube::core::Status = serde_json::from_str(IMAGE_PULL_BACKOFF).unwrap();
        let shown = log_error(
            &kube::Error::Api(Box::new(status)),
            "app",
            "Failed to get logs",
        )
        .to_string();
        assert!(
            shown.contains("is waiting to start: trying and failing to pull image"),
            "{shown}"
        );
        assert!(!shown.contains("Status {"), "{shown}");
        assert!(!shown.contains("ListMeta"), "{shown}");
    }
}

#[cfg(test)]
mod first_line_tests {
    use super::*;

    const SAID: &str = "unable to retrieve container logs for containerd://3bb6fd00";

    /// The whole body was the sentence and then the end: a read that failed,
    /// which the panel must not draw as a line the container printed.
    #[test]
    fn a_body_that_is_only_the_refusal_never_reaches_the_buffer() {
        let mut first = FirstLine::default();
        assert!(first.arriving(SAID.to_string()).is_empty());
        assert_eq!(first.ended().as_deref(), Some(SAID));
    }

    /// A container whose first line is that sentence and which keeps going
    /// is a container with logs; holding them back would be the same lie
    /// pointed the other way.
    #[test]
    fn a_container_that_kept_printing_gets_its_first_line_back() {
        let mut first = FirstLine::default();
        assert!(first.arriving(SAID.to_string()).is_empty());
        assert_eq!(
            first.arriving("rows copied: 412".to_string()),
            vec![SAID.to_string(), "rows copied: 412".to_string()]
        );
        assert_eq!(first.ended(), None);
    }

    /// Held for one flush interval at most, and only ever the sentence.
    #[test]
    fn an_ordinary_first_line_is_never_held() {
        let mut first = FirstLine::default();
        assert_eq!(
            first.arriving("applying 015_backfill.sql".to_string()),
            vec!["applying 015_backfill.sql".to_string()]
        );
        assert_eq!(first.ended(), None);

        let mut quiet = FirstLine::default();
        assert!(quiet.arriving(SAID.to_string()).is_empty());
        assert_eq!(quiet.expired().as_deref(), Some(SAID));
        assert_eq!(quiet.ended(), None);
    }

    /// The sentence in the middle of a stream is output: a shipper replaying
    /// kubelet text, a wrapper echoing an error it captured.
    #[test]
    fn the_sentence_later_in_a_stream_is_a_line_like_any_other() {
        let mut first = FirstLine::default();
        assert_eq!(first.arriving("starting".to_string()), vec!["starting"]);
        assert_eq!(first.arriving(SAID.to_string()), vec![SAID.to_string()]);
        assert_eq!(first.ended(), None);
    }
}

#[cfg(test)]
mod next_line_tests {
    use super::*;

    async fn all_lines(bytes: &[u8]) -> Vec<String> {
        let mut reader = BufReader::new(bytes);
        let mut pending = Vec::new();
        let mut lines = Vec::new();
        while let Some(line) = next_line(&mut reader, &mut pending).await.unwrap() {
            lines.push(line);
        }
        lines
    }

    /// One byte that is not UTF-8 used to end the stream with "the log
    /// stream broke", and the lines after it were never read.
    #[tokio::test]
    async fn a_byte_that_is_not_utf8_costs_one_character_not_the_stream() {
        assert_eq!(
            all_lines(b"ok\n\xff\xfe\nafter\n").await,
            vec!["ok", "\u{fffd}\u{fffd}", "after"]
        );
    }

    /// The same line endings `lines()` stripped, and a last line with none.
    #[tokio::test]
    async fn a_line_ends_at_lf_or_crlf_and_the_last_needs_neither() {
        assert_eq!(
            all_lines(b"one\r\ntwo\nthree").await,
            vec!["one", "two", "three"]
        );
    }
}

#[cfg(test)]
mod line_batch_tests {
    use super::*;

    /// Each event the lines leave as: its size on the wire and the lines in it.
    fn sent(lines: &[String]) -> Vec<(usize, Vec<String>)> {
        let (tx, mut rx) = broadcast::channel(1024);
        let mut batch = LineBatch::new(tx, "s1".to_string());
        let intake = IntakeFilter::new(&[]);
        let mut epoch_ms = 0;
        for line in lines {
            take_line(
                line,
                "api",
                "app",
                "shop",
                &intake,
                &mut epoch_ms,
                &mut batch,
            );
            if batch.full() {
                batch.flush();
            }
        }
        batch.flush();
        drop(batch);
        let mut out = Vec::new();
        while let Ok(event) = rx.try_recv() {
            let size = event.to_json().unwrap().len();
            if let AppEvent::LogBatch { lines, .. } = event {
                out.push((size, lines.into_iter().map(|l| l.raw).collect()));
            }
        }
        out
    }

    /// A hundred JSON lines with 20 kB stack traces left as one event of
    /// about 4 MB, four times the IPC limit, because only lines were counted.
    #[test]
    fn a_burst_of_large_lines_is_cut_by_bytes_before_the_count() {
        let stack = "at com.shop.Payments.charge(Payments.java:42)\\n".repeat(400);
        let lines: Vec<String> = (0..100)
            .map(|i| format!(r#"{{"level":"error","msg":"charge {i} failed","stack":"{stack}"}}"#))
            .collect();
        let sent = sent(&lines);
        for (size, _) in &sent {
            assert!(*size <= IPC_TARGET_BYTES + 128, "{size} bytes in one event");
        }
        let back: Vec<String> = sent.into_iter().flat_map(|(_, l)| l).collect();
        assert_eq!(back, lines, "every line arrives, in order");
    }

    /// A line over the budget on its own is still output, and the lines
    /// around it do not ride along in its event.
    #[test]
    fn a_line_over_the_budget_goes_alone_and_is_not_dropped() {
        let big = "x".repeat(IPC_TARGET_BYTES + 1);
        let lines = vec!["before".to_string(), big.clone(), "after".to_string()];
        let batches: Vec<Vec<String>> = sent(&lines).into_iter().map(|(_, l)| l).collect();
        assert_eq!(
            batches,
            vec![
                vec!["before".to_string()],
                vec![big],
                vec!["after".to_string()]
            ]
        );
    }
}

#[cfg(test)]
mod follow_end_tests {
    use super::*;
    use http::{Request, Response};
    use kube::client::Body;
    use tokio_util::sync::CancellationToken;

    fn status(code: u16, reason: &str, message: &str) -> (u16, String) {
        let body = serde_json::json!({
            "kind": "Status", "apiVersion": "v1", "metadata": {}, "status": "Failure",
            "message": message, "reason": reason, "code": code,
        });
        (code, body.to_string())
    }

    /// A cluster that serves one log body and one answer for the pod.
    fn cluster(log: &'static str, pod: (u16, String)) -> Client {
        let service = tower::service_fn(move |request: Request<Body>| {
            let (status, body) = if request.uri().path().ends_with("/log") {
                (200, log.to_string())
            } else {
                pod.clone()
            };
            async move {
                Ok::<_, std::convert::Infallible>(
                    Response::builder()
                        .status(status)
                        .body(Body::from(body.into_bytes()))
                        .unwrap(),
                )
            }
        });
        Client::new(service, "k8s-gui-test")
    }

    fn pod_with(state: &serde_json::Value) -> (u16, String) {
        let pod = serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "log-demo", "namespace": "k8s-gui-test" },
            "status": {
                "phase": "Running",
                "containerStatuses": [{
                    "name": "web",
                    "image": "nginx",
                    "imageID": "",
                    "ready": true,
                    "restartCount": 0,
                    "state": state,
                }],
            },
        });
        (200, pod.to_string())
    }

    fn running_since(at: &str) -> (u16, String) {
        pod_with(&serde_json::json!({ "running": { "startedAt": at } }))
    }

    fn running_long() -> (u16, String) {
        running_since("2026-10-07T06:21:00Z")
    }

    type Told = (Vec<String>, Option<(StreamFailureKind, String)>);

    /// What the stream told the frontend: the raw text of every line, and
    /// the failure it ended on.
    async fn follow_with(streamer: LogStreamer, rx: &mut broadcast::Receiver<AppEvent>) -> Told {
        let config = LogConfig::new("log-demo", "k8s-gui-test").with_container("web");
        let mut streamer = streamer;
        streamer.settle = Duration::ZERO;
        streamer
            .stream_logs("s1".to_string(), config, CancellationToken::new())
            .await
            .unwrap();
        let (mut lines, mut failure) = (Vec::new(), None);
        while let Ok(event) = rx.try_recv() {
            match event {
                AppEvent::LogBatch { lines: batch, .. } => {
                    lines.extend(batch.into_iter().map(|line| line.raw));
                }
                AppEvent::StreamFailed { kind, message, .. } => failure = Some((kind, message)),
                _ => {}
            }
        }
        (lines, failure)
    }

    async fn follow(client: Client) -> Told {
        let (tx, mut rx) = broadcast::channel(256);
        follow_with(LogStreamer::new(Arc::new(client), tx), &mut rx).await
    }

    const LINE: &str = "2026-10-07T06:52:09.603166503Z logfmt log request_id=req-621 user=bob";
    const REFUSED: &str = "2026-10-07T06:52:09.603166503Z logfmt log request_id=req-621 user=bob\n\
                           failed to create fsnotify watcher: too many open files\n";
    const CLOSED: &str = "2026-10-07T06:52:09.603166503Z logfmt log request_id=req-621 user=bob\n";

    /// Sam's log-demo: the node ran out of watchers, wrote why into the
    /// stream and closed it, and the pane said the container was no longer
    /// running beside kubectl showing it running and writing. Fails if a
    /// follow the node gave up on is reported as the container ending, or
    /// if the node's sentence is drawn as a line the container wrote.
    #[tokio::test]
    async fn a_follow_the_node_gave_up_on_is_not_a_container_that_ended() {
        let (lines, failure) = follow(cluster(REFUSED, running_long())).await;
        assert_eq!(lines, vec![LINE]);
        assert_eq!(
            failure,
            Some((
                StreamFailureKind::FollowStopped,
                "failed to create fsnotify watcher: too many open files".to_string()
            ))
        );
    }

    /// A body that closes with nothing said, over a status still running the
    /// same run: the node let go, the container did not end.
    #[tokio::test]
    async fn a_quiet_close_over_a_running_container_is_a_stopped_follow() {
        let (lines, failure) = follow(cluster(CLOSED, running_long())).await;
        assert_eq!(lines, vec![LINE]);
        assert_eq!(
            failure,
            Some((StreamFailureKind::FollowStopped, String::new()))
        );
    }

    /// The case the old answer was right for: a crash loop's container exits
    /// and waits to start again. Fails if reading the status turned every
    /// real end into a retry offer.
    #[tokio::test]
    async fn a_container_that_exited_still_ended() {
        let waiting = pod_with(&serde_json::json!({
            "waiting": { "reason": "CrashLoopBackOff" }
        }));
        let (_, failure) = follow(cluster(CLOSED, waiting)).await;
        let (kind, message) = failure.unwrap();
        assert_eq!(kind, StreamFailureKind::Gone);
        assert!(
            message.contains("container web is no longer running"),
            "{message}"
        );
    }

    /// Running again is a later run: the one being followed ended.
    #[tokio::test]
    async fn a_container_running_a_run_that_started_after_the_follow_ended() {
        let later = running_since("2999-01-01T00:00:00Z");
        let (_, failure) = follow(cluster(CLOSED, later)).await;
        assert_eq!(failure.unwrap().0, StreamFailureKind::Gone);
    }

    #[tokio::test]
    async fn a_pod_deleted_under_the_follow_is_gone() {
        let deleted = status(404, "NotFound", "pods \"log-demo\" not found");
        let (_, failure) = follow(cluster(CLOSED, deleted)).await;
        let (kind, message) = failure.unwrap();
        assert_eq!(kind, StreamFailureKind::Gone);
        assert!(message.contains("not there any more"), "{message}");
    }

    /// Could not look is neither "ended" nor "still running": the close is
    /// reported as a lost stream with the reason, and Reconnect is offered.
    #[tokio::test]
    async fn a_pod_that_could_not_be_read_leaves_the_end_unknown() {
        let refused = status(403, "Forbidden", "pods \"log-demo\" is forbidden");
        let (_, failure) = follow(cluster(REFUSED, refused)).await;
        let (kind, message) = failure.unwrap();
        assert_eq!(kind, StreamFailureKind::Broken);
        assert!(message.contains("too many open files"), "{message}");
        assert!(message.contains("could not be read"), "{message}");
        assert!(message.contains("forbidden"), "{message}");
    }

    /// CLAUDE.md: a long-running task takes its client per attempt. Fails if
    /// the end is read with the client the stream was opened with, whose
    /// token may have expired while it was followed.
    #[tokio::test]
    async fn the_end_is_read_with_a_client_taken_when_it_ends() {
        let expired = status(401, "Unauthorized", "Unauthorized");
        let (tx, mut rx) = broadcast::channel(256);
        let fresh = Arc::new(cluster(CLOSED, running_long()));
        let streamer = LogStreamer::new(Arc::new(cluster(CLOSED, expired)), tx)
            .with_fresh_client(move || Ok(fresh.clone()));
        let (_, failure) = follow_with(streamer, &mut rx).await;
        assert_eq!(failure.unwrap().0, StreamFailureKind::FollowStopped);
    }

    /// A line with no timestamp in the middle of a followed stream is output
    /// all the same, in its place.
    #[tokio::test]
    async fn an_unstamped_line_with_more_after_it_is_output_in_order() {
        const MIDDLE: &str = "2026-10-07T06:52:09Z a\n\
                              panic: traceback continues here\n\
                              2026-10-07T06:52:10Z b\n";
        let (lines, failure) = follow(cluster(MIDDLE, running_long())).await;
        assert_eq!(
            lines,
            vec![
                "2026-10-07T06:52:09Z a",
                "panic: traceback continues here",
                "2026-10-07T06:52:10Z b"
            ]
        );
        assert_eq!(
            failure,
            Some((StreamFailureKind::FollowStopped, String::new()))
        );
    }

    /// The kubelet trims trailing zeros, so a stamp on the second is twenty
    /// characters; the parser's thirty-character floor is not this rule.
    #[test]
    fn a_short_stamp_and_an_empty_line_are_still_stamped() {
        assert!(stamped("2026-10-07T06:52:09Z ok"));
        assert!(stamped("2026-10-07T06:52:09.603166503Z "));
        assert!(!stamped(
            "failed to create fsnotify watcher: too many open files"
        ));
        assert!(!stamped("2026-10-07 is a date"));
    }
}
