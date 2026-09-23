//! Session bookkeeping types stored on `AppState` — one per active
//! resource-bearing operation (cluster connection, port-forward,
//! interactive auth flow).

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
