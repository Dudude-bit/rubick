use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock};

/// Default buffer size for terminal I/O operations (4KB)
pub const TERMINAL_BUFFER_SIZE: usize = 4096;

/// Terminal session state
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalState {
    Idle,
    Connecting,
    Connected,
    Disconnected,
    Error,
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
            cancel_tx: Some(cancel_tx),
            subscribe_tx: Some(subscribe_tx),
        };

        (session, input_rx, cancel_rx, subscribe_rx)
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

    /// Close the session
    pub fn close(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
}
