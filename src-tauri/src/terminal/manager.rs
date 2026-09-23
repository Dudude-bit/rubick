use crate::error::{Error, Result};
use crate::state::{readable_cause, AppEvent, StreamFailureKind};
use crate::terminal::session::{TerminalInput, TerminalSession, TerminalState};
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::broadcast;

/// How the wait for the frontend's subscribe signal ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gate {
    /// The frontend registered its listeners; events sent from here on
    /// will be received.
    Released,
    /// The session was closed before the frontend ever attached.
    Cancelled,
    /// The frontend never called back. Emitting anyway is a guess, but
    /// a silent wedged session is worse.
    TimedOut,
}

/// Seconds to wait for the frontend before giving up on the gate.
const SUBSCRIBE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_mins(1);

/// How long the loop keeps reading after the child is gone, for an adapter
/// that says something can still arrive.
///
/// **The child exiting is not the stream ending.** A Windows console hands
/// its buffer over *after* the process has died, so stopping at
/// `is_running()` drops whatever it still held — and for a credential plugin
/// what it still held is the token. This loop, which every real session runs
/// through and no test did, broke on the first empty read (#148).
///
/// Only for `TerminalAdapter::may_still_deliver`: a pod shell saw its own
/// EOF and waiting past it would hold the exec socket, the session entry and
/// the "Connected" badge for a second of nothing.
const QUIET_AFTER_EXIT: tokio::time::Duration = tokio::time::Duration::from_secs(1);

/// Terminal manager for handling multiple sessions
pub struct TerminalManager {
    event_tx: broadcast::Sender<AppEvent>,
    sessions: Arc<DashMap<String, TerminalSession>>,
}

impl TerminalManager {
    /// Create a new terminal manager
    #[must_use]
    pub fn new(event_tx: broadcast::Sender<AppEvent>) -> Self {
        Self {
            event_tx,
            sessions: Arc::new(DashMap::new()),
        }
    }

    /// Send input to a session
    pub async fn send_input(&self, id: &str, data: &str) -> Result<()> {
        if let Some(session) = self.sessions.get(id) {
            session.send(data).await?;
            Ok(())
        } else {
            Err(Error::Terminal(format!("Session {id} not found")))
        }
    }

    /// Resize a session
    pub async fn resize_session(&self, id: &str, width: u16, height: u16) -> Result<()> {
        if let Some(session) = self.sessions.get(id) {
            session.resize(width, height).await?;
            Ok(())
        } else {
            Err(Error::Terminal(format!("Session {id} not found")))
        }
    }

    /// Close a session
    pub fn close_session(&self, id: &str) -> Result<()> {
        if let Some((_, mut session)) = self.sessions.remove(id) {
            session.close();
            Ok(())
        } else {
            // Already closed or not found, just return Ok
            Ok(())
        }
    }

    /// Release the subscribe gate for a session, signalling that the
    /// frontend has registered its `terminal-output` / `terminal-closed`
    /// listeners and is ready to receive events. Idempotent.
    ///
    /// Returns an error only if the session ID is unknown — callers can
    /// surface that to the frontend so a malicious caller cannot release
    /// arbitrary IDs without a registered session.
    pub fn mark_subscribed(&self, id: &str) -> Result<()> {
        if let Some(mut session) = self.sessions.get_mut(id) {
            session.mark_subscribed();
            Ok(())
        } else {
            Err(Error::Terminal(format!("Session {id} not found")))
        }
    }

    /// Get number of active sessions
    #[must_use]
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// Create a new terminal session with the given adapter
    ///
    /// This is the only public method for creating sessions - it's completely generic
    /// and doesn't know about pods, processes, or any specific session types.
    /// The caller is responsible for creating the appropriate adapter.
    ///
    /// Returns the `session_id` for tracking.
    pub async fn create_session(
        &self,
        mut adapter: Box<dyn crate::terminal::TerminalAdapter>,
    ) -> Result<String> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let (session, mut input_rx, mut cancel_rx, subscribe_rx) =
            TerminalSession::new(session_id.clone());

        let event_tx = self.event_tx.clone();
        let session_state = session.state.clone();

        // Update state to connecting
        {
            let mut state = session_state.write().await;
            *state = TerminalState::Connecting;
        }

        self.sessions.insert(session_id.clone(), session);

        let session_id_clone = session_id.clone();
        let sessions = self.sessions.clone();

        // Spawn task with adapter ownership
        tokio::spawn(async move {
            // `create_session` has already returned the id by now, so a
            // connect failure here lands *after* the caller believes it
            // has a working session — the exec upgrade being rejected
            // with a 500 is exactly this. Hold the error and report it
            // through the same gate as everything else: the frontend's
            // listeners do not exist yet, and Tauri events have no
            // replay, so emitting now would put the only explanation
            // of the blank pane into the void.
            let connect_error = adapter.connect().await.err();

            *session_state.write().await = if connect_error.is_some() {
                TerminalState::Error
            } else {
                TerminalState::Connected
            };

            // Wait for the frontend to signal it has registered its
            // event listeners. The cancel channel is armed too, so a
            // session closed during startup unwinds cleanly, and a
            // safety timeout prevents a wedged session if the frontend
            // never calls `terminal_subscribed` (e.g. browser crash).
            let gate = tokio::select! {
                _ = subscribe_rx => Gate::Released,
                _ = &mut cancel_rx => Gate::Cancelled,
                () = tokio::time::sleep(SUBSCRIBE_TIMEOUT) => {
                    tracing::warn!(
                        "Terminal session {} subscribe gate timed out after {}s",
                        session_id_clone,
                        SUBSCRIBE_TIMEOUT.as_secs(),
                    );
                    Gate::TimedOut
                }
            };

            if let Some(e) = connect_error {
                tracing::error!("Failed to connect adapter: {}", e);
                let _ = adapter.close().await;
                sessions.remove(&session_id_clone);

                if gate != Gate::Cancelled {
                    let kind = StreamFailureKind::classify(&e);
                    let cause = readable_cause(&e);
                    emit_failure(
                        &event_tx,
                        &session_id_clone,
                        kind,
                        match kind {
                            StreamFailureKind::Gone => {
                                format!("There is no container left to attach to — {cause}.")
                            }
                            // An exec has no previous run and no log to drop;
                            // either kind here still means the shell did not open.
                            StreamFailureKind::Broken
                            | StreamFailureKind::NoPreviousRun
                            | StreamFailureKind::LogNotKept => {
                                format!("Could not open the shell — {cause}.")
                            }
                        },
                    );
                }

                let _ = event_tx.send(AppEvent::TerminalClosed {
                    session_id: session_id_clone,
                    status: Some(format!("Failed to connect: {e}")),
                });
                return;
            }

            if gate == Gate::Cancelled {
                tracing::debug!(
                    "Terminal session {} cancelled before subscribe",
                    session_id_clone
                );
                let _ = adapter.close().await;
                *session_state.write().await = TerminalState::Disconnected;
                sessions.remove(&session_id_clone);
                let _ = event_tx.send(AppEvent::TerminalClosed {
                    session_id: session_id_clone,
                    status: None,
                });
                return;
            }

            // I/O loop
            let mut quiet_since: Option<tokio::time::Instant> = None;
            let mut output = Output::default();
            loop {
                tokio::select! {
                    _ = &mut cancel_rx => {
                        tracing::debug!("Terminal session {} cancelled", session_id_clone);
                        break;
                    }
                    input = input_rx.recv() => {
                        match input {
                            Some(TerminalInput::Data(data)) => {
                                if let Err(e) = adapter.write_input(data.as_bytes()).await {
                                    // Already gone: the same drop that ended
                                    // the stream closed stdin, so this is the
                                    // session ending and not a shell that
                                    // broke. Reported, it paints a red
                                    // "Reconnect" over a clean exit.
                                    if !adapter.is_running() {
                                        break;
                                    }
                                    tracing::error!("Failed to write input: {}", e);
                                    emit_failure(
                                        &event_tx,
                                        &session_id_clone,
                                        StreamFailureKind::Broken,
                                        format!(
                                            "The shell stopped accepting input — {}.",
                                            readable_cause(&e)
                                        ),
                                    );
                                    break;
                                }
                            }
                            Some(TerminalInput::Resize { width, height }) => {
                                let _ = adapter.resize(width, height).await;
                            }
                            None => {
                                tracing::debug!("Input channel closed");
                                break;
                            }
                        }
                    }
                    // Read as soon as there is something, not on a 50 ms
                    // tick: the tick capped a busy shell at one 4 KB chunk
                    // per tick, and put every echo up to a tick behind the
                    // key. Every adapter's read waits briefly for data and is
                    // cancel-safe, so a keystroke interrupts it without loss.
                    read = timed(adapter.read_output()) => {
                        match read {
                            (Ok(Some(data)), _) => {
                                quiet_since = None;
                                output.push(&data);
                                if output.due() {
                                    send_output(&event_tx, &session_id_clone, output.take());
                                }
                            }
                            (Ok(None), waited) => {
                                // Nothing more for now: what was gathered goes.
                                if !output.is_empty() {
                                    send_output(&event_tx, &session_id_clone, output.take());
                                }
                                if adapter.is_running() {
                                    quiet_since = None;
                                } else if !adapter.may_still_deliver() {
                                    break;
                                } else {
                                    // Gone, but see `QUIET_AFTER_EXIT`: what the
                                    // console had left is still on its way.
                                    match quiet_since {
                                        None => quiet_since = Some(tokio::time::Instant::now()),
                                        Some(since) if since.elapsed() >= QUIET_AFTER_EXIT => break,
                                        Some(_) => {}
                                    }
                                }
                                // A read that answered "nothing" without waiting
                                // would spin this loop; the real adapters wait.
                                if waited < IDLE_READ {
                                    tokio::time::sleep(IDLE_READ).await;
                                }
                            }
                            (Err(e), _) => {
                                tracing::error!("Failed to read output: {}", e);
                                emit_failure(
                                    &event_tx,
                                    &session_id_clone,
                                    StreamFailureKind::classify(&e),
                                    format!(
                                        "The shell connection dropped — {}.",
                                        readable_cause(&e)
                                    ),
                                );
                                break;
                            }
                        }
                    }
                }
            }
            // Whatever is left, a cut-off character included, is the last of
            // what the shell said.
            if !output.is_empty() {
                send_output(&event_tx, &session_id_clone, output.finish());
            }

            // Cleanup
            let _ = adapter.close().await;
            *session_state.write().await = TerminalState::Disconnected;

            sessions.remove(&session_id_clone);

            let _ = event_tx.send(AppEvent::TerminalClosed {
                session_id: session_id_clone,
                status: None,
            });
        });

        Ok(session_id)
    }
}

/// A read that answered in less than this is taken as not having waited.
const IDLE_READ: tokio::time::Duration = tokio::time::Duration::from_millis(5);

/// How much output is gathered before it goes out regardless.
const OUTPUT_BATCH: usize = 64 * 1024;

/// How long gathered output may wait for more before it goes out anyway.
const OUTPUT_WAIT: tokio::time::Duration = tokio::time::Duration::from_millis(16);

async fn timed<T>(read: impl std::future::Future<Output = T>) -> (T, tokio::time::Duration) {
    let started = tokio::time::Instant::now();
    let value = read.await;
    (value, started.elapsed())
}

/// Output gathered between sends: one event per burst rather than per read,
/// and never a character split across two events.
#[derive(Default)]
struct Output {
    bytes: Vec<u8>,
    since: Option<tokio::time::Instant>,
}

impl Output {
    fn push(&mut self, data: &[u8]) {
        self.since.get_or_insert_with(tokio::time::Instant::now);
        self.bytes.extend_from_slice(data);
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn due(&self) -> bool {
        self.bytes.len() >= OUTPUT_BATCH
            || self
                .since
                .is_some_and(|since| since.elapsed() >= OUTPUT_WAIT)
    }

    /// Everything up to a character a read cut in half, which stays for the
    /// next send: decoded on its own, each half was a U+FFFD, and a line of
    /// Cyrillic came out with holes in it wherever a read ended.
    fn take(&mut self) -> String {
        let keep = incomplete_tail(&self.bytes);
        let tail = self.bytes.split_off(self.bytes.len() - keep);
        let text = String::from_utf8_lossy(&self.bytes).into_owned();
        self.bytes = tail;
        self.since = (!self.bytes.is_empty()).then(tokio::time::Instant::now);
        text
    }

    fn finish(&mut self) -> String {
        self.since = None;
        String::from_utf8_lossy(&std::mem::take(&mut self.bytes)).into_owned()
    }
}

/// How many bytes at the end begin a UTF-8 character that has not finished.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        let needs = match byte {
            0xF0..=0xF7 => 4,
            0xE0..=0xEF => 3,
            0xC0..=0xDF => 2,
            _ => 1,
        };
        return if needs > back { back } else { 0 };
    }
    0
}

fn send_output(event_tx: &broadcast::Sender<AppEvent>, session_id: &str, data: String) {
    if data.is_empty() {
        return;
    }
    let _ = event_tx.send(AppEvent::TerminalOutput {
        session_id: session_id.to_string(),
        data,
    });
}

/// Tell the frontend a session stopped on its own. Send failures are
/// ignored: no receiver means no window left to inform.
fn emit_failure(
    event_tx: &broadcast::Sender<AppEvent>,
    session_id: &str,
    kind: StreamFailureKind,
    message: String,
) {
    let _ = event_tx.send(AppEvent::StreamFailed {
        stream_id: session_id.to_string(),
        kind,
        message,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::TerminalAdapter;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    /// Fake adapter: counts `read_output` calls so the test can assert
    /// the read loop didn't start before the gate was released.
    /// Hands over a burst of chunks as fast as it is asked, then ends.
    struct Burst {
        chunks: std::collections::VecDeque<Vec<u8>>,
    }

    #[async_trait::async_trait]
    impl TerminalAdapter for Burst {
        async fn connect(&mut self) -> Result<()> {
            Ok(())
        }

        async fn read_output(&mut self) -> Result<Option<Vec<u8>>> {
            Ok(self.chunks.pop_front())
        }

        async fn write_input(&mut self, _data: &[u8]) -> Result<()> {
            Ok(())
        }

        async fn resize(&mut self, _cols: u16, _rows: u16) -> Result<()> {
            Ok(())
        }

        async fn close(&mut self) -> Result<()> {
            Ok(())
        }

        fn is_running(&self) -> bool {
            !self.chunks.is_empty()
        }
    }

    async fn everything_said(adapter: Burst) -> Vec<String> {
        let (event_tx, mut event_rx) = broadcast::channel(4096);
        let manager = TerminalManager::new(event_tx);
        let session_id = manager
            .create_session(Box::new(adapter))
            .await
            .expect("create_session");
        manager.mark_subscribed(&session_id).expect("subscribed");
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut said = Vec::new();
            loop {
                match event_rx.recv().await.expect("the bus stays open") {
                    AppEvent::TerminalOutput { data, .. } => said.push(data),
                    AppEvent::TerminalClosed { .. } => return said,
                    _ => {}
                }
            }
        })
        .await
        .expect("the session ends")
    }

    /// A read split "привет" between two bytes of one letter, and each half,
    /// decoded on its own, became a U+FFFD.
    #[tokio::test]
    async fn a_character_split_between_two_reads_arrives_whole() {
        let text = "привет, мир\n".repeat(3);
        let bytes = text.as_bytes();
        let chunks = bytes.chunks(5).map(<[u8]>::to_vec).collect();
        let said = everything_said(Burst { chunks }).await.concat();
        assert_eq!(said, text);
    }

    /// Output goes out in bursts, not one event per read: two thousand reads
    /// of a busy shell were two thousand trips across the bridge, whose
    /// buffer holds a thousand.
    #[tokio::test]
    async fn a_busy_shell_is_sent_in_bursts_and_in_order() {
        let chunks: std::collections::VecDeque<Vec<u8>> = (0..2000)
            .map(|i| format!("{i:05}\n").into_bytes())
            .collect();
        let said = everything_said(Burst { chunks }).await;
        let joined = said.concat();
        let expected: String = (0..2000).map(|i| format!("{i:05}\n")).collect();
        assert_eq!(joined, expected);
        assert!(said.len() < 200, "{} events for 2000 reads", said.len());
    }

    /// Where a character begins and has not finished.
    #[test]
    fn the_unfinished_end_of_a_buffer_is_measured_in_bytes() {
        let letter = "и".as_bytes();
        assert_eq!(incomplete_tail(&letter[..1]), 1);
        assert_eq!(incomplete_tail(letter), 0);
        let emoji = "😀".as_bytes();
        assert_eq!(incomplete_tail(&emoji[..3]), 3);
        assert_eq!(incomplete_tail(b"plain"), 0);
        // Stray continuation bytes finish nothing; they are decoded as they are.
        assert_eq!(incomplete_tail(&[0x80, 0x80, 0x80]), 0);
    }

    struct CountingAdapter {
        connected: Arc<AtomicBool>,
        reads: Arc<AtomicUsize>,
        payload: Vec<u8>,
        delivered: Arc<AtomicBool>,
    }

    impl CountingAdapter {
        fn new(payload: &[u8]) -> (Self, Arc<AtomicUsize>, Arc<AtomicBool>) {
            let reads = Arc::new(AtomicUsize::new(0));
            let delivered = Arc::new(AtomicBool::new(false));
            (
                Self {
                    connected: Arc::new(AtomicBool::new(false)),
                    reads: reads.clone(),
                    payload: payload.to_vec(),
                    delivered: delivered.clone(),
                },
                reads,
                delivered,
            )
        }
    }

    #[async_trait::async_trait]
    impl TerminalAdapter for CountingAdapter {
        async fn connect(&mut self) -> Result<()> {
            self.connected.store(true, Ordering::SeqCst);
            Ok(())
        }

        async fn read_output(&mut self) -> Result<Option<Vec<u8>>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.delivered.swap(true, Ordering::SeqCst) {
                Ok(None)
            } else {
                Ok(Some(self.payload.clone()))
            }
        }

        async fn write_input(&mut self, _data: &[u8]) -> Result<()> {
            Ok(())
        }

        async fn resize(&mut self, _cols: u16, _rows: u16) -> Result<()> {
            Ok(())
        }

        async fn close(&mut self) -> Result<()> {
            self.connected.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn is_running(&self) -> bool {
            self.connected.load(Ordering::SeqCst)
        }
    }

    /// A child that goes quiet, then dies, with its last bytes still on the
    /// way — the shape of a Windows console, which hands its buffer over
    /// after the process has died.
    ///
    /// Alive for the first `alive_for` reads, so the loop's "still running"
    /// arm is exercised too: without it a quiet second while the child was
    /// still working would end the session.
    struct GoneButStillTalking {
        reads: usize,
        alive_for: usize,
        payload_at: usize,
        payload: Vec<u8>,
        console: bool,
        writes_fail: bool,
    }

    impl GoneButStillTalking {
        fn console(payload: &[u8]) -> Self {
            Self {
                reads: 0,
                alive_for: 2,
                payload_at: 5,
                payload: payload.to_vec(),
                console: true,
                writes_fail: false,
            }
        }
    }

    #[async_trait::async_trait]
    impl TerminalAdapter for GoneButStillTalking {
        async fn connect(&mut self) -> Result<()> {
            Ok(())
        }

        async fn read_output(&mut self) -> Result<Option<Vec<u8>>> {
            self.reads += 1;
            // Quiet while alive, quiet again once gone, and the payload two
            // reads after the death — a chunk no `is_running()` check can
            // wait for on its own.
            if self.reads == self.payload_at {
                Ok(Some(self.payload.clone()))
            } else {
                Ok(None)
            }
        }

        async fn write_input(&mut self, _data: &[u8]) -> Result<()> {
            if self.writes_fail {
                Err(Error::Terminal("Write failed: broken pipe".to_string()))
            } else {
                Ok(())
            }
        }

        async fn resize(&mut self, _cols: u16, _rows: u16) -> Result<()> {
            Ok(())
        }

        async fn close(&mut self) -> Result<()> {
            Ok(())
        }

        fn is_running(&self) -> bool {
            self.reads < self.alive_for
        }

        fn may_still_deliver(&self) -> bool {
            self.console
        }
    }

    /// What the child had left is read even though the child is gone.
    ///
    /// The loop used to break on the first empty read once `is_running()`
    /// went false. For a credential plugin the bytes that go missing that way
    /// are the token, the flow then reports a plugin that "produced no
    /// output", and in a silent renewal two of those in a row put the Sign in
    /// screen back up (#148). Fails if the break returns.
    #[tokio::test]
    async fn a_child_that_has_exited_still_gets_read_to_the_end() {
        let (event_tx, mut event_rx) = broadcast::channel(64);
        let manager = TerminalManager::new(event_tx);

        let session_id = manager
            .create_session(Box::new(GoneButStillTalking::console(
                b"{\"kind\":\"ExecCredential\"}",
            )))
            .await
            .expect("create_session");
        manager.mark_subscribed(&session_id).expect("subscribed");

        let heard = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match event_rx.recv().await.expect("the bus stays open") {
                    AppEvent::TerminalOutput { data, .. } => return Some(data),
                    AppEvent::TerminalClosed { .. } => return None,
                    _ => {}
                }
            }
        })
        .await
        .expect("the session ends either way");

        assert_eq!(
            heard.as_deref(),
            Some("{\"kind\":\"ExecCredential\"}"),
            "the loop closed the session before the console handed its buffer over"
        );
    }

    /// A stream whose end the adapter saw for itself ends the session at
    /// once.
    ///
    /// Only a console keeps talking past the child, and the second spent
    /// waiting for one is a second a pod shell would hold its exec socket,
    /// its session entry and its "Connected" badge for nothing. Fails if
    /// `may_still_deliver` stops being consulted.
    #[tokio::test]
    async fn a_stream_that_is_over_ends_the_session_without_waiting() {
        let (event_tx, mut event_rx) = broadcast::channel(64);
        let manager = TerminalManager::new(event_tx);

        let mut adapter = GoneButStillTalking::console(b"never read");
        adapter.console = false;
        let session_id = manager
            .create_session(Box::new(adapter))
            .await
            .expect("create_session");
        manager.mark_subscribed(&session_id).expect("subscribed");

        let started = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let AppEvent::TerminalClosed { .. } =
                    event_rx.recv().await.expect("the bus stays open")
                {
                    return;
                }
            }
        })
        .await
        .expect("the session closes");

        assert!(
            started.elapsed() < QUIET_AFTER_EXIT,
            "waited the console's grace on a stream that had already ended: {:?}",
            started.elapsed()
        );
    }

    /// A shell that simply has nothing to say is not closed under the reader.
    ///
    /// The quiet window is for a child that has *gone*. Without the arm that
    /// resets it while `is_running()` holds, a pod shell waiting at its
    /// prompt reaches the "stream is over" arm on its first idle tick and
    /// the pane closes under the person typing into it. Fails if that arm is
    /// deleted.
    #[tokio::test]
    async fn a_shell_that_goes_quiet_is_not_closed_under_the_reader() {
        let (event_tx, mut event_rx) = broadcast::channel(64);
        let manager = TerminalManager::new(event_tx);

        let mut adapter = GoneButStillTalking::console(b"$ ");
        adapter.console = false;
        adapter.alive_for = 100;
        adapter.payload_at = 3;
        let session_id = manager
            .create_session(Box::new(adapter))
            .await
            .expect("create_session");
        manager.mark_subscribed(&session_id).expect("subscribed");

        let heard = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match event_rx.recv().await.expect("the bus stays open") {
                    AppEvent::TerminalOutput { data, .. } => return Some(data),
                    AppEvent::TerminalClosed { .. } => return None,
                    _ => {}
                }
            }
        })
        .await
        .expect("the session says something either way");

        assert_eq!(
            heard.as_deref(),
            Some("$ "),
            "an idle tick closed a shell that was still running"
        );
    }

    /// A keystroke that lands after the shell is gone closes the pane; it
    /// does not paint a fault over it.
    ///
    /// `PodExecAdapter`'s stdin and stdout die in the same drop, so a key
    /// pressed between the shell exiting and the pane hearing about it fails
    /// to write. Reported, it reaches `PodTerminal` as a red "The shell
    /// stopped accepting input" with a Reconnect button over what was a
    /// clean `exit`. Fails if the write error is announced again.
    #[tokio::test]
    async fn a_keystroke_after_the_shell_is_gone_is_not_a_fault() {
        let (event_tx, mut event_rx) = broadcast::channel(64);
        let manager = TerminalManager::new(event_tx);

        let mut adapter = GoneButStillTalking::console(b"logout");
        adapter.alive_for = 0;
        adapter.writes_fail = true;
        let session_id = manager
            .create_session(Box::new(adapter))
            .await
            .expect("create_session");
        manager.mark_subscribed(&session_id).expect("subscribed");
        manager
            .send_input(&session_id, "q")
            .await
            .expect("the pane still thinks it is connected");

        let heard = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match event_rx.recv().await.expect("the bus stays open") {
                    AppEvent::StreamFailed { message, .. } => return Some(message),
                    AppEvent::TerminalClosed { .. } => return None,
                    _ => {}
                }
            }
        })
        .await
        .expect("the session ends either way");

        assert_eq!(
            heard, None,
            "a clean exit was reported as a shell that stopped accepting input"
        );
    }

    #[tokio::test]
    async fn read_output_is_not_called_before_subscribe() {
        let (event_tx, _event_rx) = broadcast::channel(64);
        let manager = TerminalManager::new(event_tx);
        let (adapter, reads, _delivered) = CountingAdapter::new(b"hello");

        let _session_id = manager
            .create_session(Box::new(adapter))
            .await
            .expect("create_session");

        // Give the spawned task plenty of time to run connect() and
        // (incorrectly) start reading. The 50ms read tick * 6 = 300ms
        // is more than enough for any leakage to surface.
        tokio::time::sleep(Duration::from_millis(300)).await;

        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "read_output must not be called before mark_subscribed"
        );
    }

    #[tokio::test]
    async fn output_is_broadcast_after_subscribe() {
        let (event_tx, mut event_rx) = broadcast::channel(64);
        let manager = TerminalManager::new(event_tx);
        let (adapter, _reads, _delivered) = CountingAdapter::new(b"hello");

        let session_id = manager
            .create_session(Box::new(adapter))
            .await
            .expect("create_session");

        // Confirm the gate is holding (no events while we wait).
        let early = tokio::time::timeout(Duration::from_millis(150), event_rx.recv()).await;
        assert!(
            early.is_err(),
            "no events should be emitted before subscribe; got {early:?}"
        );

        // Release the gate.
        manager
            .mark_subscribed(&session_id)
            .expect("mark_subscribed");

        // Now we expect a TerminalOutput within a couple of read ticks.
        let event = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
            .await
            .expect("event within timeout")
            .expect("event delivered");

        match event {
            AppEvent::TerminalOutput {
                session_id: sid,
                data,
            } => {
                assert_eq!(sid, session_id);
                assert_eq!(data, "hello");
            }
            other => panic!("expected TerminalOutput, got {other:?}"),
        }
    }

    /// Adapter whose `connect` fails the way the exec upgrade does on
    /// a cluster that answers the handshake with a 500.
    struct FailingConnectAdapter(Error);

    #[async_trait::async_trait]
    impl TerminalAdapter for FailingConnectAdapter {
        async fn connect(&mut self) -> Result<()> {
            Err(match &self.0 {
                Error::Terminal(m) => Error::Terminal(m.clone()),
                other => Error::Terminal(other.to_string()),
            })
        }
        async fn read_output(&mut self) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn write_input(&mut self, _data: &[u8]) -> Result<()> {
            Ok(())
        }
        async fn resize(&mut self, _cols: u16, _rows: u16) -> Result<()> {
            Ok(())
        }
        async fn close(&mut self) -> Result<()> {
            Ok(())
        }
        fn is_running(&self) -> bool {
            false
        }
    }

    /// The whole point of the variant: `create_session` hands back an
    /// id, the upgrade is rejected a moment later, and the frontend
    /// has to hear about it. It cannot hear about it before its
    /// listeners exist, so the failure has to wait on the same gate
    /// that output does.
    #[tokio::test]
    async fn connect_failure_is_reported_after_the_subscribe_gate() {
        let (event_tx, mut event_rx) = broadcast::channel(64);
        let manager = TerminalManager::new(event_tx);

        let session_id = manager
            .create_session(Box::new(FailingConnectAdapter(Error::Terminal(
                "Failed to exec: failed to upgrade to a WebSocket connection: 500".into(),
            ))))
            .await
            .expect("create_session returns an id even though the connect will fail");

        let early = tokio::time::timeout(Duration::from_millis(150), event_rx.recv()).await;
        assert!(
            early.is_err(),
            "the failure must not be emitted before the frontend subscribes; got {early:?}"
        );

        manager
            .mark_subscribed(&session_id)
            .expect("session must still be registered so the frontend can release the gate");

        let event = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
            .await
            .expect("event within timeout")
            .expect("event delivered");

        match event {
            AppEvent::StreamFailed {
                stream_id,
                kind,
                message,
            } => {
                assert_eq!(stream_id, session_id);
                assert_eq!(
                    kind,
                    StreamFailureKind::Broken,
                    "a rejected upgrade says nothing about the pod existing"
                );
                assert_eq!(
                    message,
                    "Could not open the shell — failed to upgrade to a WebSocket connection: 500."
                );
            }
            other => panic!("expected StreamFailed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn connect_failure_on_a_missing_container_is_reported_as_gone() {
        let (event_tx, mut event_rx) = broadcast::channel(64);
        let manager = TerminalManager::new(event_tx);

        let session_id = manager
            .create_session(Box::new(FailingConnectAdapter(Error::Terminal(
                "Failed to exec: ApiError: pods \"api-0\" not found: NotFound".into(),
            ))))
            .await
            .expect("create_session");

        manager
            .mark_subscribed(&session_id)
            .expect("mark_subscribed");

        let event = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
            .await
            .expect("event within timeout")
            .expect("event delivered");

        match event {
            AppEvent::StreamFailed { kind, message, .. } => {
                assert_eq!(kind, StreamFailureKind::Gone);
                assert!(
                    message.starts_with("There is no container left to attach to"),
                    "gone must not read like a retryable connection failure: {message}"
                );
            }
            other => panic!("expected StreamFailed, got {other:?}"),
        }
    }

    #[test]
    fn mark_subscribed_unknown_session_errors() {
        let (event_tx, _event_rx) = broadcast::channel(8);
        let manager = TerminalManager::new(event_tx);

        let err = manager.mark_subscribed("not-a-real-id").unwrap_err();
        assert!(
            matches!(err, Error::Terminal(_)),
            "unknown session must return Error::Terminal, got {err:?}"
        );
    }
}
