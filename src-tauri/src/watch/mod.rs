//! Kubernetes resource watch subsystem.
//!
//! One `kube::runtime::watcher` per (cluster, kind, namespace) tuple streams
//! `applied` / `deleted` / `restarted` events; they are collected into ~50ms
//! batches and forwarded to the frontend over the same broadcast channel as
//! the rest of the app's events. The frontend updates the `TanStack` Query
//! cache directly via `setQueryData` — no refetch round-trip.
//!
//! Deferred-start handshake, the same one terminal-auth and log-stream use:
//! the spawned task blocks on a oneshot gate until the frontend has installed
//! its `listen("resource-event")` callback, and only then starts the watcher.
//! Without the gate the initial `restarted` event — which the watcher always
//! emits before its first applied burst — could land in the void.
//!
//! - `session`: `WatchSession` bookkeeping + RAII cleanup guard
//! - `event`:   kube watcher Events → batched `AppEvent::ResourceWatchEvent`

mod event;
mod failure;
mod session;

pub use session::WatchSession;

use crate::error::{Error, Result};
use crate::state::AppEvent;
use crate::utils::generate_id;
use dashmap::DashMap;
use futures::StreamExt;
use k8s_openapi::{ClusterResourceScope, NamespaceResourceScope};
use kube::core::DynamicObject;
use kube::discovery::ApiResource;
use kube::runtime::watcher::{watcher, Config as WatcherConfig};
use kube::{Api, Client};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot};
use tokio::time::{interval, MissedTickBehavior};

use event::{emit_failure, WatchBatch, FLUSH_INTERVAL};
use failure::FailureLatch;
use session::WatchCleanup;

/// Manages all active resource watches.
pub struct WatchManager {
    event_tx: broadcast::Sender<AppEvent>,
    sessions: Arc<DashMap<String, WatchSession>>,
}

impl WatchManager {
    #[must_use]
    pub fn new(event_tx: broadcast::Sender<AppEvent>) -> Self {
        Self {
            event_tx,
            sessions: Arc::new(DashMap::new()),
        }
    }

    /// Number of active watch sessions.
    #[must_use]
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// Release the subscribe gate for a session. Errors only on
    /// unknown ids so a malicious caller cannot release arbitrary
    /// streams. Idempotent.
    pub fn mark_subscribed(&self, id: &str) -> Result<()> {
        if let Some(mut entry) = self.sessions.get_mut(id) {
            entry.mark_subscribed();
            Ok(())
        } else {
            Err(Error::Internal(format!("Resource watch {id} not found")))
        }
    }

    /// Cancel and remove a watch session. Idempotent — removing an
    /// already-removed session is a no-op so racing `unsubscribe`
    /// calls don't fail.
    pub fn unsubscribe(&self, id: &str) {
        if let Some((_, mut session)) = self.sessions.remove(id) {
            session.close();
        }
    }

    /// Subscribe to changes on a typed Kubernetes resource list and
    /// return a stream id the frontend can use to listen for events
    /// and to unsubscribe later.
    ///
    /// `K` is the typed resource kind from `k8s_openapi`.
    /// `transform` converts each watched resource into the shape the
    /// frontend's `TanStack` Query cache holds (e.g. `ConfigMapInfo`,
    /// `PodInfo`). Returning `None` drops the event — used for
    /// resources the UI doesn't care about (system pods, etc.).
    ///
    /// `kind_label` is a debug-only string stored on the session.
    pub fn subscribe<K, F, U>(
        &self,
        client: Client,
        kind_label: &str,
        namespace: Option<String>,
        transform: F,
    ) -> String
    where
        K: kube::Resource<DynamicType = (), Scope = NamespaceResourceScope>
            + Clone
            + std::fmt::Debug
            + serde::de::DeserializeOwned
            + Send
            + Sync
            + 'static,
        F: Fn(&K) -> Option<U> + Send + Sync + 'static,
        U: Serialize,
    {
        let api: Api<K> = match &namespace {
            Some(ns) => Api::namespaced(client, ns),
            None => Api::all(client),
        };
        self.spawn_watcher(api, kind_label, namespace, transform)
    }

    /// Subscribe to changes on a runtime-discovered custom resource.
    /// Used for CRDs where the type isn't known at compile time —
    /// caller passes the resolved `ApiResource` (group/version/kind/
    /// plural) and a transform that converts each `DynamicObject` to
    /// the shape the frontend cache holds (`CustomResourceInfo`).
    pub fn subscribe_custom_resource<F, U>(
        &self,
        client: Client,
        api_resource: &ApiResource,
        kind_label: &str,
        namespace: Option<String>,
        transform: F,
    ) -> String
    where
        F: Fn(&DynamicObject) -> Option<U> + Send + Sync + 'static,
        U: Serialize,
    {
        let api: Api<DynamicObject> = match &namespace {
            Some(ns) => Api::namespaced_with(client, ns, api_resource),
            None => Api::all_with(client, api_resource),
        };
        self.spawn_watcher(api, kind_label, namespace, transform)
    }

    /// Cluster-scoped sibling of `subscribe`. For resources like
    /// Node, Namespace, `PersistentVolume`, `StorageClass` that don't
    /// belong to any single namespace.
    pub fn subscribe_cluster<K, F, U>(
        &self,
        client: Client,
        kind_label: &str,
        transform: F,
    ) -> String
    where
        K: kube::Resource<DynamicType = (), Scope = ClusterResourceScope>
            + Clone
            + std::fmt::Debug
            + serde::de::DeserializeOwned
            + Send
            + Sync
            + 'static,
        F: Fn(&K) -> Option<U> + Send + Sync + 'static,
        U: Serialize,
    {
        let api: Api<K> = Api::all(client);
        self.spawn_watcher(api, kind_label, None, transform)
    }

    /// Shared spawn loop for both subscribe variants: the session-table
    /// insert, the deferred-start gate, the watcher loop, and the RAII
    /// cleanup guard.
    ///
    /// Must be called from a Tokio context — it spawns. Every caller is a
    /// `#[tauri::command] async fn` for that reason; making one of them sync
    /// puts it on a reactor-less worker thread, where the `tokio::spawn` below
    /// panics across the IPC FFI boundary and aborts the process rather than
    /// returning an error.
    fn spawn_watcher<K, F, U>(
        &self,
        api: Api<K>,
        kind_label: &str,
        namespace: Option<String>,
        transform: F,
    ) -> String
    where
        K: kube::Resource
            + Clone
            + std::fmt::Debug
            + serde::de::DeserializeOwned
            + Send
            + Sync
            + 'static,
        F: Fn(&K) -> Option<U> + Send + Sync + 'static,
        U: Serialize,
    {
        let stream_id = generate_id("rw");
        let stream_id_clone = stream_id.clone();

        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let (subscribe_tx, subscribe_rx) = oneshot::channel::<()>();
        let event_tx = self.event_tx.clone();
        let sessions = self.sessions.clone();

        self.sessions.insert(
            stream_id.clone(),
            WatchSession {
                id: stream_id.clone(),
                kind: kind_label.to_string(),
                namespace,
                cancel_tx: Some(cancel_tx),
                subscribe_tx: Some(subscribe_tx),
            },
        );

        tokio::spawn(async move {
            // RAII: removes the session entry on every exit path.
            let _cleanup = WatchCleanup {
                sessions: sessions.clone(),
                key: stream_id_clone.clone(),
            };

            // Wait for the frontend to install its listener (or for
            // an early cancel / 60s safety timeout). Mirrors the
            // terminal-auth and log-stream gates.
            let mut cancel_rx = cancel_rx;
            tokio::select! {
                _ = subscribe_rx => {}
                _ = &mut cancel_rx => {
                    tracing::debug!(
                        "Resource watch {} cancelled before subscribe",
                        stream_id_clone
                    );
                    return;
                }
                () = tokio::time::sleep(std::time::Duration::from_mins(1)) => {
                    tracing::warn!(
                        "Resource watch {} subscribe gate timed out after 60s; \
                         starting watcher anyway",
                        stream_id_clone
                    );
                }
            }

            let mut stream = watcher(api, WatcherConfig::default()).boxed();

            // Surface watcher failures (RBAC denial, network hiccups) to the
            // frontend as a `Failed` event after a streak of consecutive
            // errors. `FailureLatch` owns the threshold and emit-once
            // behaviour; see `watch/failure.rs`.
            let mut latch = FailureLatch::new();

            // Changes are collected and flushed on a timer instead of
            // being emitted one by one — see `event::FLUSH_INTERVAL`.
            let mut batch = WatchBatch::new(stream_id_clone.clone());
            let mut flush_timer = interval(FLUSH_INTERVAL);
            // First tick fires immediately; skip it so an empty buffer
            // doesn't emit right after subscribe.
            flush_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
            flush_timer.tick().await;

            loop {
                tokio::select! {
                    biased;
                    _ = &mut cancel_rx => {
                        tracing::debug!("Resource watch {} cancelled", stream_id_clone);
                        break;
                    }
                    _ = flush_timer.tick() => {
                        batch.flush(&event_tx);
                    }
                    next = stream.next() => {
                        match next {
                            Some(Ok(event)) => {
                                latch.record_success();
                                if batch.push(event, &transform) {
                                    batch.flush(&event_tx);
                                }
                            }
                            Some(Err(e)) => {
                                let should_emit = latch.record_error();
                                tracing::error!(
                                    "Resource watch {} error ({} in a row): {}",
                                    stream_id_clone,
                                    latch.consecutive_errors(),
                                    e
                                );
                                if should_emit {
                                    // Whatever is buffered was still true when
                                    // it arrived; it goes out before the
                                    // failure so the list the reader falls back
                                    // on is not needlessly behind.
                                    batch.flush(&event_tx);
                                    emit_failure(&event_tx, &stream_id_clone, e.to_string());
                                }
                            }
                            None => {
                                tracing::debug!(
                                    "Resource watch {} stream ended",
                                    stream_id_clone
                                );
                                break;
                            }
                        }
                    }
                }
            }

            // Nothing is left to trigger a flush for what the last tick
            // did not cover.
            batch.flush(&event_tx);
        });

        stream_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_session(
        id: &str,
        kind: &str,
    ) -> (WatchSession, oneshot::Receiver<()>, oneshot::Receiver<()>) {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (subscribe_tx, subscribe_rx) = oneshot::channel();
        let session = WatchSession {
            id: id.to_string(),
            kind: kind.to_string(),
            namespace: None,
            cancel_tx: Some(cancel_tx),
            subscribe_tx: Some(subscribe_tx),
        };
        (session, cancel_rx, subscribe_rx)
    }

    #[test]
    fn watch_cleanup_guard_removes_entry_on_drop() {
        let sessions: Arc<DashMap<String, WatchSession>> = Arc::new(DashMap::new());
        let (session, _crx, _srx) = make_session("k", "ConfigMap");
        sessions.insert("k".to_string(), session);
        assert_eq!(sessions.len(), 1);

        {
            let _guard = WatchCleanup {
                sessions: sessions.clone(),
                key: "k".to_string(),
            };
        }

        assert_eq!(
            sessions.len(),
            0,
            "guard's Drop must remove the entry — same path runs on panic-unwind"
        );
    }

    #[test]
    fn mark_subscribed_unknown_id_errors() {
        let (event_tx, _rx) = broadcast::channel(8);
        let manager = WatchManager::new(event_tx);

        let err = manager.mark_subscribed("does-not-exist").unwrap_err();
        assert!(
            matches!(err, Error::Internal(_)),
            "expected Error::Internal, got {err:?}"
        );
    }

    #[test]
    fn unsubscribe_unknown_id_is_a_noop() {
        let (event_tx, _rx) = broadcast::channel(8);
        let manager = WatchManager::new(event_tx);

        // Must not panic.
        manager.unsubscribe("does-not-exist");
        assert_eq!(manager.session_count(), 0);
    }
}
