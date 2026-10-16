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
//! - `event`:   kube watcher Events → batched `AppEvent::ResourceWatchEvent`
//! - `scope`:   several namespaces, a watcher each, as one stream

mod event;
mod failure;
mod scope;

use crate::commands::helpers::{api_in, scope_of};
use crate::error::{watch_failure, watch_refused, Error, Result};
use crate::state::{AppEvent, WatchOp};
use crate::utils::generate_id;
use futures::StreamExt;
use k8s_openapi::{ClusterResourceScope, NamespaceResourceScope};
use kube::core::DynamicObject;
use kube::discovery::ApiResource;
use kube::runtime::watcher::{watcher, Config as WatcherConfig};
use kube::{Api, Client};
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::{interval, MissedTickBehavior};

use event::{emit_failure, WatchBatch, FLUSH_INTERVAL};
use failure::{paced, until, FailureLatch, Step};
use scope::{Out, ScopeSync};

pub(crate) use failure::{answered, backoff_for};

/// Manages all active resource watches.
pub struct WatchManager {
    event_tx: broadcast::Sender<AppEvent>,
    sessions: crate::state::streams::Streams,
}

/// What the API server is asked to hold a watch open for, in seconds. Just
/// under the five minutes kube used to enforce from the client side.
const WATCH_TIMEOUT_SECS: u32 = 290;

/// What the API server narrows a watch to, so only the objects asked about
/// cross the wire: one by name, or those a selector picks.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Narrow {
    labels: Option<String>,
    fields: Option<String>,
}

impl Narrow {
    #[must_use]
    pub fn labels(selector: String) -> Self {
        Self {
            labels: Some(selector),
            fields: None,
        }
    }

    #[must_use]
    pub fn fields(selector: String) -> Self {
        Self {
            labels: None,
            fields: Some(selector),
        }
    }

    fn named(name: Option<String>) -> Self {
        Self {
            labels: None,
            fields: name.map(|name| format!("metadata.name={name}")),
        }
    }

    fn config(&self) -> WatcherConfig {
        let mut config = WatcherConfig::default().timeout(WATCH_TIMEOUT_SECS);
        if let Some(labels) = &self.labels {
            config = config.labels(labels);
        }
        if let Some(fields) = &self.fields {
            config = config.fields(fields);
        }
        config
    }
}

impl WatchManager {
    #[must_use]
    pub fn new(event_tx: broadcast::Sender<AppEvent>) -> Self {
        Self {
            event_tx,
            sessions: crate::state::streams::Streams::default(),
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
        if self.sessions.contains(id) {
            let _ = self.sessions.subscribed(id);
            Ok(())
        } else {
            Err(Error::Internal(format!("Resource watch {id} not found")))
        }
    }

    /// Cancel and remove a watch session. Idempotent — removing an
    /// already-removed session is a no-op so racing `unsubscribe`
    /// calls don't fail.
    pub fn unsubscribe(&self, id: &str) {
        let _ = self.sessions.stop(id);
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
    /// `kind_label` names the kind in the log lines about this watch.
    ///
    /// `scope` is `None` for the whole cluster, one namespace, or several —
    /// each watched on its own behind one resync barrier (`scope.rs`).
    pub fn subscribe<K, F, U>(
        &self,
        client: Client,
        kind_label: &str,
        scope: Option<Vec<String>>,
        transform: F,
    ) -> Result<String>
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
        self.subscribe_across(
            move |reach| api_in::<K>(&client, reach),
            kind_label,
            scope,
            transform,
        )
    }

    /// A runtime-discovered kind's list across `scope`; see `subscribe`.
    pub fn subscribe_custom_list<F, U>(
        &self,
        client: Client,
        api_resource: &ApiResource,
        kind_label: &str,
        scope: Option<Vec<String>>,
        transform: F,
    ) -> Result<String>
    where
        F: Fn(&DynamicObject) -> Option<U> + Send + Sync + 'static,
        U: Serialize,
    {
        self.subscribe_across(
            move |reach| match reach {
                Some(ns) => Api::namespaced_with(client.clone(), ns, api_resource),
                None => Api::all_with(client.clone(), api_resource),
            },
            kind_label,
            scope,
            transform,
        )
    }

    fn subscribe_across<K, F, U>(
        &self,
        api: impl Fn(Option<&str>) -> Api<K>,
        kind_label: &str,
        scope: Option<Vec<String>>,
        transform: F,
    ) -> Result<String>
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
        Ok(match scope_of(scope)? {
            None => self.spawn_watcher(api(None), kind_label, Narrow::default(), transform),
            Some(names) if names.len() == 1 => self.spawn_watcher(
                api(Some(&names[0])),
                kind_label,
                Narrow::default(),
                transform,
            ),
            Some(names) => {
                let members = names
                    .into_iter()
                    .map(|name| {
                        let api = api(Some(&name));
                        (name, api)
                    })
                    .collect();
                self.spawn_scope_watcher(members, kind_label, transform)
            }
        })
    }

    /// One namespaced object by name. The API server does the narrowing
    /// through a field selector, so watching a single pod in a namespace of
    /// ten thousand costs one object's worth of traffic, not the namespace's.
    pub fn subscribe_object<K, F, U>(
        &self,
        client: Client,
        kind_label: &str,
        namespace: &str,
        name: String,
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
        let api: Api<K> = Api::namespaced(client, namespace);
        self.spawn_watcher(api, kind_label, Narrow::named(Some(name)), transform)
    }

    /// The objects of a namespaced kind that `narrow` picks, in one namespace
    /// or, where `namespace` is `None`, across the cluster.
    pub fn subscribe_narrowed<K, F, U>(
        &self,
        client: Client,
        kind_label: &str,
        namespace: Option<&str>,
        narrow: Narrow,
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
        let api: Api<K> = match namespace {
            Some(namespace) => Api::namespaced(client, namespace),
            None => Api::all(client),
        };
        self.spawn_watcher(api, kind_label, narrow, transform)
    }

    /// One cluster-scoped object by name; see `subscribe_object`.
    pub fn subscribe_cluster_object<K, F, U>(
        &self,
        client: Client,
        kind_label: &str,
        name: String,
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
        self.spawn_watcher(api, kind_label, Narrow::named(Some(name)), transform)
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
        name: Option<String>,
        transform: F,
    ) -> String
    where
        F: Fn(&DynamicObject) -> Option<U> + Send + Sync + 'static,
        U: Serialize,
    {
        let api: Api<DynamicObject> = match namespace {
            Some(ns) => Api::namespaced_with(client, &ns, api_resource),
            None => Api::all_with(client, api_resource),
        };
        self.spawn_watcher(api, kind_label, Narrow::named(name), transform)
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
        self.spawn_watcher(api, kind_label, Narrow::default(), transform)
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
        narrow: Narrow,
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
        // What every log line about this watch says it is.
        let label = format!("{stream_id} ({kind_label})");

        let event_tx = self.event_tx.clone();
        let mut opened = self.sessions.open(stream_id.clone());

        tokio::spawn(async move {
            // Wait for the frontend to install its listener, or for an early
            // cancel, which wins; after the timeout it starts anyway.
            if !opened
                .wait_for_subscriber(crate::state::streams::SUBSCRIBE_TIMEOUT)
                .await
            {
                tracing::debug!("Resource watch {} cancelled before subscribe", label);
                return;
            }
            let (cancel, _held) = opened.split();

            // The API server closes the watch at this limit and the watcher
            // re-lists, which is what recycles one that has gone quiet. Until
            // `read_timeout` was removed from the client, kube's own 295-second
            // socket timer did this by accident; now it is asked for.
            let mut stream = watcher(api, narrow.config()).boxed();

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
                    () = cancel.cancelled() => {
                        tracing::debug!("Resource watch {} cancelled", label);
                        break;
                    }
                    _ = flush_timer.tick() => {
                        batch.flush(&event_tx);
                    }
                    next = stream.next() => {
                        match next {
                            Some(Ok(event)) => {
                                // The rule is inside `saw`: a marker does not
                                // clear a streak, an answer does.
                                latch.saw(&event);
                                if batch.push(event, &transform) {
                                    batch.flush(&event_tx);
                                }
                            }
                            Some(Err(e)) => {
                                let step = latch.failed(watch_refused(&e));
                                if step == Step::Stop {
                                    let message = watch_failure(&e);
                                    tracing::warn!("Resource watch {} refused, stopped: {}", label, message);
                                    batch.flush(&event_tx);
                                    emit_failure(&event_tx, &stream_id_clone, message);
                                    break;
                                }
                                tracing::error!(
                                    "Resource watch {} error ({} in a row): {}",
                                    label,
                                    latch.consecutive_errors(),
                                    watch_failure(&e)
                                );
                                if step == Step::Tell {
                                    // Whatever is buffered was still true when
                                    // it arrived; it goes out before the
                                    // failure so the list the reader falls back
                                    // on is not needlessly behind.
                                    batch.flush(&event_tx);
                                    emit_failure(&event_tx, &stream_id_clone, watch_failure(&e));
                                }
                                // Cancel still wins, or a closing window
                                // waits out the whole sleep.
                                let wait = backoff_for(latch.consecutive_errors());
                                tokio::select! {
                                    biased;
                                    () = cancel.cancelled() => {
                                        tracing::debug!(
                                            "Resource watch {} cancelled while backing off",
                                            label
                                        );
                                        break;
                                    }
                                    () = tokio::time::sleep(wait) => {}
                                }
                            }
                            None => {
                                tracing::debug!(
                                    "Resource watch {} stream ended",
                                    label
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

    /// One stream over several namespaces, a watcher each: the same gate,
    /// batching and cancel as `spawn_watcher`, with `ScopeSync` deciding what
    /// the page is told.
    fn spawn_scope_watcher<K, F, U>(
        &self,
        members: Vec<(String, Api<K>)>,
        kind_label: &str,
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
        let id = stream_id.clone();
        let label = format!("{stream_id} ({kind_label})");
        let event_tx = self.event_tx.clone();
        let mut opened = self.sessions.open(stream_id.clone());

        tokio::spawn(async move {
            if !opened
                .wait_for_subscriber(crate::state::streams::SUBSCRIBE_TIMEOUT)
                .await
            {
                tracing::debug!("Resource watch {} cancelled before subscribe", label);
                return;
            }
            let (cancel, _held) = opened.split();

            let config = WatcherConfig::default().timeout(WATCH_TIMEOUT_SECS);
            let (namespaces, apis): (Vec<_>, Vec<_>) = members.into_iter().unzip();
            let mut merged =
                futures::stream::select_all(apis.into_iter().enumerate().map(|(at, api)| {
                    until(
                        paced(watcher(api, config.clone()).boxed(), backoff_for).boxed(),
                        |event| matches!(event, Err(e) if watch_refused(e)),
                    )
                    .map(move |event| (at, event))
                    .boxed()
                }));
            let mut sync = ScopeSync::new(namespaces);
            let mut out = Vec::new();

            let mut batch = WatchBatch::new(id.clone());
            let mut flush_timer = interval(FLUSH_INTERVAL);
            flush_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
            flush_timer.tick().await;

            loop {
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => {
                        tracing::debug!("Resource watch {} cancelled", label);
                        break;
                    }
                    _ = flush_timer.tick() => batch.flush(&event_tx),
                    next = merged.next() => {
                        let Some((at, event)) = next else {
                            tracing::debug!("Resource watch {} stream ended", label);
                            break;
                        };
                        let refused = matches!(&event, Err(e) if watch_refused(e));
                        if let Err(e) = &event {
                            if refused {
                                tracing::warn!(
                                    "Resource watch {} in {} refused, stopped: {}",
                                    label,
                                    sync.namespace(at),
                                    watch_failure(e)
                                );
                            } else {
                                tracing::error!(
                                    "Resource watch {} in {} error ({} in a row): {}",
                                    label,
                                    sync.namespace(at),
                                    sync.streak(at) + 1,
                                    watch_failure(e)
                                );
                            }
                        }
                        match event.map_err(|e| watch_failure(&e)) {
                            Err(message) if refused => sync.refused(at, message, &mut out),
                            event => sync.on(at, event, &transform, &mut out),
                        }
                        for said in out.drain(..) {
                            match said {
                                Out::Change(op, raw) => {
                                    if batch.push_raw(op, raw) {
                                        batch.flush(&event_tx);
                                    }
                                }
                                Out::Marker(op) => {
                                    batch.marker(op);
                                    if op == WatchOp::Synced {
                                        batch.flush(&event_tx);
                                    }
                                }
                                Out::Failed(message) => {
                                    batch.flush(&event_tx);
                                    emit_failure(&event_tx, &id, message);
                                }
                            }
                        }
                    }
                }
            }

            batch.flush(&event_tx);
        });

        stream_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
