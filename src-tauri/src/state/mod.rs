//! Application state management.
//!
//! Holds active connections, cached data, and the event broadcast
//! channel.
//!
//! - `events`:   `AppEvent` enum + `LogLineEvent` + `WatchOp`
//! - `sessions`: Session / `PortForwardSession` / `AuthSessionControl` /
//!   `LogStream` bookkeeping types

mod events;
mod sessions;

pub use events::{
    is_missing_previous_run, readable_cause, AppEvent, LogLineEvent, StreamFailureKind,
    WatchChange, WatchOp,
};
pub use sessions::{AuthSessionControl, LogStream, PortForwardSession, Session};

use crate::client::K8sClientManager;
use crate::config::AppConfig;
use crate::error::Result;
use crate::terminal::TerminalManager;
use dashmap::DashMap;
use parking_lot::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Global application state
pub struct AppState {
    /// Application configuration
    pub config: Arc<RwLock<AppConfig>>,

    /// Kubernetes client manager
    pub client_manager: Arc<K8sClientManager>,

    /// Active sessions by context
    pub sessions: DashMap<String, Session>,

    /// Current active context
    pub current_context: Arc<RwLock<Option<String>>>,

    /// Terminal session manager
    pub terminal_manager: Arc<TerminalManager>,

    /// Resource watch manager. Owns active `kube::runtime::watcher`
    /// streams keyed by stream id; the frontend subscribes per
    /// resource list and gets `resource-event` Tauri events instead
    /// of polling every 2 seconds.
    pub watch_manager: Arc<crate::watch::WatchManager>,

    /// Cross-cluster search manager. Owns the in-flight fan-out and
    /// its cancellation, the same way `watch_manager` owns watches.
    pub search_manager: Arc<crate::search::SearchManager>,

    /// Node drains in flight. Owns the retry loop and its cancellation,
    /// the same way `search_manager` owns a fan-out.
    pub drain_manager: Arc<crate::drain::DrainManager>,

    /// Active port-forward sessions
    pub port_forward_sessions: Arc<DashMap<String, PortForwardSession>>,

    /// Port-forward cancel controls
    /// One cancellation per live forward, held for the session's whole life
    /// rather than just its accept loop. A oneshot could only be fired once
    /// and only be awaited in one place, so the established connections —
    /// each its own detached task — had nothing to listen to and outlived
    /// the session that owned them.
    pub port_forward_controls: Arc<DashMap<String, tokio_util::sync::CancellationToken>>,

    /// Active log streams
    pub log_streams: Arc<DashMap<String, LogStream>>,

    /// Event broadcaster
    pub event_tx: broadcast::Sender<AppEvent>,

    /// Active auth sessions
    pub auth_sessions: DashMap<String, AuthSessionControl>,

    /// Monotonic counter for connection attempts
    pub connect_generation: AtomicU64,

    /// Active debug operations (ephemeral container/debug pod creation)
    pub debug_operations: DashMap<String, crate::commands::debug::DebugOperation>,
}

impl AppState {
    /// Create a new application state
    pub fn new() -> Result<Self> {
        let config = AppConfig::load()?;
        let (event_tx, _) = broadcast::channel(1000);

        let client_manager = Arc::new(K8sClientManager::new());

        let drain_manager = Arc::new(crate::drain::DrainManager::new(event_tx.clone()));

        let search_manager = Arc::new(crate::search::SearchManager::new(
            event_tx.clone(),
            client_manager.clone(),
        ));

        Ok(Self {
            config: Arc::new(RwLock::new(config)),
            client_manager,
            search_manager,
            drain_manager,
            sessions: DashMap::new(),
            current_context: Arc::new(RwLock::new(None)),
            terminal_manager: Arc::new(TerminalManager::new(event_tx.clone())),
            watch_manager: Arc::new(crate::watch::WatchManager::new(event_tx.clone())),
            port_forward_sessions: Arc::new(DashMap::new()),
            port_forward_controls: Arc::new(DashMap::new()),
            log_streams: Arc::new(DashMap::new()),
            event_tx,
            auth_sessions: DashMap::new(),
            connect_generation: AtomicU64::new(0),
            debug_operations: DashMap::new(),
        })
    }

    /// Subscribe to application events
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.event_tx.subscribe()
    }

    /// Increment and return the current connection attempt generation
    pub fn next_connect_generation(&self) -> u64 {
        self.connect_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Check if the generation is still the latest
    pub fn is_latest_connect_generation(&self, generation: u64) -> bool {
        self.connect_generation.load(Ordering::SeqCst) == generation
    }

    /// Emit an event to all subscribers
    pub fn emit(&self, event: AppEvent) {
        let _ = self.event_tx.send(event);
    }

    /// Create a new auth session
    pub fn create_auth_session(
        &self,
        context: &str,
        flow: &str,
    ) -> (String, tokio::sync::oneshot::Receiver<()>) {
        let session_id = Uuid::new_v4().to_string();
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let session = AuthSessionControl {
            context: context.to_string(),
            flow: flow.to_string(),
            cancel_tx,
        };
        self.auth_sessions.insert(session_id.clone(), session);
        (session_id, cancel_rx)
    }

    /// Remove an auth session
    pub fn remove_auth_session(&self, session_id: &str) -> Option<AuthSessionControl> {
        self.auth_sessions
            .remove(session_id)
            .map(|(_, session)| session)
    }

    /// Cancel all auth sessions for a context
    pub fn cancel_auth_sessions_for_context(&self, context: &str) -> Vec<String> {
        let session_ids: Vec<String> = self
            .auth_sessions
            .iter()
            .filter_map(|entry| {
                if entry.value().context == context {
                    Some(entry.key().clone())
                } else {
                    None
                }
            })
            .collect();
        for session_id in &session_ids {
            if let Some((_, session)) = self.auth_sessions.remove(session_id) {
                let _ = session.cancel_tx.send(());
            }
        }
        session_ids
    }

    /// Get current context
    pub fn get_current_context(&self) -> Option<String> {
        self.current_context.read().clone()
    }

    /// Set current context
    pub fn set_current_context(&self, context: Option<String>) {
        *self.current_context.write() = context;
    }

    /// Create a new session
    pub fn create_session(&self, context: &str) -> Session {
        let session = Session {
            id: Uuid::new_v4().to_string(),
            context: context.to_string(),
            connected_at: chrono::Utc::now(),
        };
        self.sessions.insert(context.to_string(), session.clone());
        session
    }

    /// Remove a session
    pub fn remove_session(&self, context: &str) {
        self.sessions.remove(context);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new().expect("Failed to create default AppState")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_management() {
        let state = AppState::new().unwrap();

        let session = state.create_session("test-context");
        assert_eq!(session.context, "test-context");
        assert!(state.sessions.contains_key("test-context"));

        state.remove_session("test-context");
        assert!(!state.sessions.contains_key("test-context"));
    }

    #[test]
    fn test_event_subscription() {
        let state = AppState::new().unwrap();
        let mut rx = state.subscribe();

        state.emit(AppEvent::Error {
            code: "TEST".to_string(),
            message: "test".to_string(),
        });

        // Event should be received
        let event = rx.try_recv();
        assert!(event.is_ok());
    }
}
