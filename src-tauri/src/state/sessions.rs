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

/// A list being streamed to the frontend in chunks; see
/// `commands::pods::list_pod_rows`. Same gate as a log stream, for the
/// same reason.
#[derive(Debug)]
pub struct ListStream {
    pub cancel_tx: tokio::sync::oneshot::Sender<()>,
    pub subscribe_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

/// Removes a map entry when dropped, so every exit path of a spawned task,
/// the panicking one included, leaves no stale session behind.
pub struct RemoveOnDrop<V> {
    pub map: std::sync::Arc<dashmap::DashMap<String, V>>,
    pub key: String,
}

impl<V> Drop for RemoveOnDrop<V> {
    fn drop(&mut self) {
        self.map.remove(&self.key);
    }
}
