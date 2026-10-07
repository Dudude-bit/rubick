//! One metadata-only watch per kind, or per kind and namespace where the
//! cluster refused the kind across it.

use std::sync::Arc;

use futures::StreamExt;
use kube::api::{Api, DynamicObject};
use kube::core::PartialObjectMeta;
use kube::discovery::ApiResource;
use kube::runtime::watcher::{self, Event};
use tracing::Level;

use super::graph::{Node, OwnerLink, SlotKey};
use super::{ClusterIndex, SlotState};
use crate::error::watch_failure;
use crate::watch::{answered, backoff_for};

/// Just under the five minutes an API server allows a watch.
const WATCH_TIMEOUT_SECS: u32 = 290;
const PAGE_SIZE: u32 = 500;

type Meta = PartialObjectMeta<DynamicObject>;

pub(super) fn spawn(index: &Arc<ClusterIndex>, slot: SlotKey, resource: ApiResource) {
    let known = index.refusals.lock().get(&slot).cloned();
    if let Some(message) = known {
        index.refused(&slot, message);
        return;
    }
    index.slots.lock().insert(slot.clone(), SlotState::Syncing);
    let index = index.clone();
    tokio::spawn(async move {
        let api: Api<Meta> = match &slot.namespace {
            Some(namespace) => Api::namespaced_with(index.client.clone(), namespace, &resource),
            None => Api::all_with(index.client.clone(), &resource),
        };
        let config = watcher::Config::default()
            .page_size(PAGE_SIZE)
            .timeout(WATCH_TIMEOUT_SECS);
        let stream = watcher::watcher(api, config);
        futures::pin_mut!(stream);
        let mut errors = 0u32;
        loop {
            let next = tokio::select! {
                biased;
                () = index.stop.cancelled() => break,
                next = stream.next() => next,
            };
            match next {
                Some(Ok(event)) => {
                    if answered(&event) {
                        errors = 0;
                    }
                    index.saw(&slot, &resource, event);
                }
                Some(Err(error)) => {
                    errors += 1;
                    let message = watch_failure(&error);
                    if refused(&error) {
                        told_refused(&slot);
                        index.refused(&slot, message);
                        break;
                    }
                    index.failed(&slot, message);
                    tokio::select! {
                        biased;
                        () = index.stop.cancelled() => break,
                        () = tokio::time::sleep(backoff_for(errors)) => {}
                    }
                }
                None => break,
            }
        }
    });
}

/// A kind refused across the cluster warns once per connection, since a
/// refusal is kept and never asked again; its namespaces add nothing above debug.
pub(super) fn refusal_level(slot: &SlotKey) -> Level {
    if slot.namespace.is_none() {
        Level::WARN
    } else {
        Level::DEBUG
    }
}

fn told_refused(slot: &SlotKey) {
    let (group, plural) = (&slot.kind.group, &slot.kind.plural);
    let namespace = slot.namespace.as_deref().unwrap_or_default();
    if refusal_level(slot) == Level::WARN {
        tracing::warn!(group, plural, "ownership index: refused across the cluster");
    } else {
        tracing::debug!(
            group,
            plural,
            namespace,
            "ownership index: refused in the namespace"
        );
    }
}

fn refused(error: &watcher::Error) -> bool {
    use watcher::Error as Watch;
    match error {
        Watch::InitialListFailed(e) | Watch::WatchStartFailed(e) | Watch::WatchFailed(e) => {
            matches!(e, kube::Error::Api(status) if status.code == 403 || status.reason == "Forbidden")
        }
        Watch::WatchError(status) => status.code == 403,
        Watch::NoResourceVersion => false,
    }
}

fn node_of(meta: &Meta, resource: &ApiResource) -> Option<(String, Node)> {
    let metadata = &meta.metadata;
    let uid = metadata.uid.clone()?;
    let owners = metadata
        .owner_references
        .iter()
        .flatten()
        .map(|reference| OwnerLink {
            uid: reference.uid.clone(),
            controller: reference.controller.unwrap_or(false),
        })
        .collect();
    Some((
        uid,
        Node {
            key: super::KindKey {
                group: resource.group.clone(),
                plural: resource.plural.clone(),
            },
            kind: resource.kind.clone(),
            version: resource.version.clone(),
            name: metadata.name.clone().unwrap_or_default(),
            namespace: metadata.namespace.clone(),
            owners,
        },
    ))
}

impl ClusterIndex {
    fn saw(&self, slot: &SlotKey, resource: &ApiResource, event: Event<Meta>) {
        match event {
            Event::Init => {
                self.graph.write().relist(slot);
                self.slots.lock().insert(slot.clone(), SlotState::Syncing);
            }
            Event::InitApply(meta) | Event::Apply(meta) => {
                if let Some((uid, node)) = node_of(&meta, resource) {
                    self.graph.write().apply(slot, uid, node);
                }
            }
            Event::InitDone => {
                self.graph.write().listed(slot);
                self.slots.lock().insert(slot.clone(), SlotState::Live);
            }
            Event::Delete(meta) => {
                if let Some(uid) = meta.metadata.uid.as_deref() {
                    self.graph.write().delete(slot, uid);
                }
            }
        }
    }

    /// A live watch that breaks keeps what it held, marked as of now; one
    /// that never listed has nothing to keep.
    fn failed(&self, slot: &SlotKey, message: String) {
        let mut slots = self.slots.lock();
        let next = match slots.get(slot) {
            Some(SlotState::Live) => SlotState::Stale {
                since: chrono::Utc::now().to_rfc3339(),
            },
            Some(stale @ SlotState::Stale { .. }) => stale.clone(),
            _ => SlotState::Failed { message },
        };
        slots.insert(slot.clone(), next);
    }

    /// Nothing more will be read here. Across the cluster, the window's
    /// namespaces are tried instead.
    fn refused(self: &Arc<Self>, slot: &SlotKey, message: String) {
        self.refusals.lock().insert(slot.clone(), message.clone());
        self.graph.write().drop_slot(slot);
        self.slots
            .lock()
            .insert(slot.clone(), SlotState::Refused { message });
        if slot.namespace.is_none() {
            if let Some(namespaces) = self.scope.lock().clone() {
                self.fall_back(&slot.kind, &namespaces);
            }
        }
    }
}
