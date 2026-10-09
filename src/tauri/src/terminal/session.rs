use crate::error::{Error, Result};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

/// Bytes read from a terminal at a time. At 4 KB a busy shell was capped
/// near 80 KB/s.
pub const TERMINAL_BUFFER_SIZE: usize = 32 * 1024;

/// Terminal session state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalState {
    Idle,
    Connecting,
    Connected,
    /// Asked to end, and still hanging up the process on the far side.
    Closing,
    Disconnected,
    Error,
}

/// The container a session runs in, for the list of shells the app holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTarget {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
}

/// One shell the backend holds, as Activity and the status bar count it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub state: TerminalState,
    pub opened_at: String,
}

/// Terminal input types
#[derive(Debug)]
pub enum TerminalInput {
    Data(String),
    Resize { width: u16, height: u16 },
}

/// Terminal session handle
pub struct TerminalSession {
    /// Session ID
    pub id: String,
    /// Input sender
    input_tx: mpsc::Sender<TerminalInput>,
    /// State
    pub(crate) state: Arc<RwLock<TerminalState>>,
    target: Option<SessionTarget>,
    opened_at: String,
    /// Cancel signal
    cancel_tx: Option<oneshot::Sender<()>>,
    /// Subscribe gate. Released by `mark_subscribed()` once the
    /// frontend has registered its event listeners. The I/O loop
    /// blocks on the matching receiver before reading from the
    /// adapter, so early output bytes don't get emitted into the
    /// void before any listener exists.
    subscribe_tx: Option<oneshot::Sender<()>>,
}

impl TerminalSession {
    pub(crate) fn new(
        id: String,
        target: Option<SessionTarget>,
    ) -> (
        Self,
        mpsc::Receiver<TerminalInput>,
        oneshot::Receiver<()>,
        oneshot::Receiver<()>,
    ) {
        let (input_tx, input_rx) = mpsc::channel(100);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (subscribe_tx, subscribe_rx) = oneshot::channel();
        let state = Arc::new(RwLock::new(TerminalState::Idle));

        let session = Self {
            id,
            input_tx,
            state,
            target,
            opened_at: chrono::Utc::now().to_rfc3339(),
            cancel_tx: Some(cancel_tx),
            subscribe_tx: Some(subscribe_tx),
        };

        (session, input_rx, cancel_rx, subscribe_rx)
    }

    /// What Activity lists for this session, or nothing for one that is not a
    /// shell in a container (a credential plugin's console).
    #[must_use]
    pub fn info(&self) -> Option<TerminalSessionInfo> {
        let target = self.target.as_ref()?;
        Some(TerminalSessionInfo {
            id: self.id.clone(),
            context: target.context.clone(),
            namespace: target.namespace.clone(),
            pod: target.pod.clone(),
            container: target.container.clone(),
            state: *self.state.read(),
            opened_at: self.opened_at.clone(),
        })
    }

    #[must_use]
    pub fn is_listed(&self) -> bool {
        self.target.is_some()
    }

    /// Release the subscribe gate so the I/O loop can start reading.
    /// Idempotent — calling twice is a no-op.
    pub fn mark_subscribed(&mut self) {
        if let Some(tx) = self.subscribe_tx.take() {
            // Receiver may already have been dropped (session closed
            // during startup). That's fine — nothing to release.
            let _ = tx.send(());
        }
    }

    /// Send data to terminal
    pub async fn send(&self, data: &str) -> Result<()> {
        self.input_tx
            .send(TerminalInput::Data(data.to_string()))
            .await
            .map_err(|e| Error::Terminal(format!("Failed to send: {e}")))
    }

    /// Resize terminal
    pub async fn resize(&self, width: u16, height: u16) -> Result<()> {
        self.input_tx
            .send(TerminalInput::Resize { width, height })
            .await
            .map_err(|e| Error::Terminal(format!("Failed to resize: {e}")))
    }

    /// Ask the session to end. Whether it was still running is the answer.
    pub fn close(&mut self) -> bool {
        let Some(tx) = self.cancel_tx.take() else {
            return false;
        };
        *self.state.write() = TerminalState::Closing;
        let _ = tx.send(());
        true
    }
}
