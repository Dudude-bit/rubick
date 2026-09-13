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

/// How long the loop keeps reading after the child is gone.
///
/// **The child exiting is not the stream ending.** A Windows console hands
/// its buffer over *after* the process has died, so stopping at
/// `is_running()` drops whatever it still held — and for a credential plugin
/// what it still held is the token. `AuthExecAdapter::drain_to_exit` has
/// waited a second of quiet since #106; this loop, which every real session
/// runs through and no test did, broke on the first empty read (#148).
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
                    () = tokio::time::sleep(tokio::time::Duration::from_millis(50)) => {
                        match adapter.read_output().await {
                            Ok(Some(data)) => {
                                quiet_since = None;
                                let data_str = String::from_utf8_lossy(&data).to_string();
                                let _ = event_tx.send(AppEvent::TerminalOutput {
                                    session_id: session_id_clone.clone(),
                                    data: data_str,
                                });
                            }
                            Ok(None) if adapter.is_running() => quiet_since = None,
                            Ok(None) => {
                                // Gone, but see `QUIET_AFTER_EXIT`: what the
                                // console had left is still on its way.
                                match quiet_since {
                                    None => quiet_since = Some(tokio::time::Instant::now()),
                                    Some(since) if since.elapsed() >= QUIET_AFTER_EXIT => break,
                                    Some(_) => {}
                                }
                            }
                            Err(e) => {
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

    /// A child that is already gone, with its last bytes still on the way.
    ///
    /// `is_running()` false from the first read, the payload on the third:
    /// the shape of a Windows console, which hands its buffer over after the
    /// process has died. `cat` on a real pty never does this, which is how a
    /// truncated credential reached two releases.
    struct GoneButStillTalking {
        reads: usize,
        payload: Vec<u8>,
    }

    #[async_trait::async_trait]
    impl TerminalAdapter for GoneButStillTalking {
        async fn connect(&mut self) -> Result<()> {
            Ok(())
        }

        async fn read_output(&mut self) -> Result<Option<Vec<u8>>> {
            self.reads += 1;
            if self.reads == 3 {
                Ok(Some(self.payload.clone()))
            } else {
                Ok(None)
            }
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
            .create_session(Box::new(GoneButStillTalking {
                reads: 0,
                payload: b"{\"kind\":\"ExecCredential\"}".to_vec(),
            }))
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
