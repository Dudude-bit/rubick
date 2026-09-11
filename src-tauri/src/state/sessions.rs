//! Session bookkeeping types stored on `AppState` — one per active
//! resource-bearing operation (cluster connection, port-forward,
//! interactive auth flow, log stream).

/// Session information for active connections
#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub context: String,
    pub connected_at: chrono::DateTime<chrono::Utc>,
}

/// Port-forward session information
#[derive(Debug, Clone)]
pub struct PortForwardSession {
    pub id: String,
    pub context: String,
    pub pod: String,
    pub namespace: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub auto_reconnect: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// Auth session control for interactive flows
#[derive(Debug)]
pub struct AuthSessionControl {
    pub context: String,
    pub flow: String,
    /// Whether anybody is being shown this sign-in. False for a background
    /// renewal: cancelling one still cancels it, but must not toast
    /// "authentication cancelled" at a reader who started none.
    pub seen: bool,
    pub cancel_tx: tokio::sync::oneshot::Sender<()>,
}

/// Log stream information
#[derive(Debug)]
pub struct LogStream {
    pub id: String,
    pub pod: String,
    pub container: String,
    pub namespace: String,
    pub cancel_tx: tokio::sync::oneshot::Sender<()>,
    /// Subscribe gate. The streaming task blocks until the frontend
    /// calls `log_stream_subscribed`, mirroring the terminal-auth fix.
    /// Without this, log-batch events emitted between command return
    /// and frontend listener registration are lost (Tauri events have
    /// no replay). `Option` so it can be taken once and dropped.
    pub subscribe_tx: Option<tokio::sync::oneshot::Sender<()>>,
}
