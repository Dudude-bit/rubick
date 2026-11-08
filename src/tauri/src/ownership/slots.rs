//! One metadata-only watch per kind, or per kind and namespace where the
//! cluster refused the kind across it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use kube::api::{Api, DynamicObject};
use kube::core::PartialObjectMeta;
use kube::discovery::ApiResource;
use kube::runtime::watcher::{self, Event};
use tracing::Level;

use super::graph::{Node, OwnerLink, SlotKey};
use super::{ClusterIndex, SlotState};
use crate::error::watch_failure;
use crate::watch::backoff_for;

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
        let mut streak = Streak::default();
        // After a failure the kind is listed afresh: kube's resumed watch says
        // nothing when it succeeds, so the slot stayed stale for good.
        'list: loop {
            let stream = watcher::watcher(api.clone(), config.clone());
            futures::pin_mut!(stream);
            loop {
                let next = tokio::select! {
                    biased;
                    () = index.stop.cancelled() => break 'list,
                    next = stream.next() => next,
                };
                match next {
                    Some(Ok(event)) => {
                        if matches!(event, Event::InitDone) {
                            streak.live(Instant::now());
                        }
                        index.saw(&slot, &resource, event);
                    }
                    Some(Err(error)) => {
                        let message = watch_failure(&error);
                        if refused(&error) {
                            told_refused(&slot);
                            index.refused(&slot, message);
                            break 'list;
                        }
                        index.failed(&slot, message);
                        tokio::select! {
                            biased;
                            () = index.stop.cancelled() => break 'list,
                            () = tokio::time::sleep(streak.failed(Instant::now())) => {}
                        }
                        continue 'list;
                    }
                    None => break 'list,
                }
            }
        }
    });
}

/// How long a watch stays live before its next failure waits from the
/// first rung again; kube's own ramp tops out here too.
const STEADY: Duration = Duration::from_secs(30);

/// Failures in a row, for the wait before listing again. A list that
/// answers is not a recovery: one whose watch then fails at once would
/// list again every second, for ever.
#[derive(Debug, Default)]
struct Streak {
    errors: u32,
    live_since: Option<Instant>,
}

impl Streak {
    fn live(&mut self, now: Instant) {
        self.live_since = Some(now);
    }

    fn failed(&mut self, now: Instant) -> Duration {
        if self
            .live_since
            .take()
            .is_some_and(|since| now.duration_since(since) >= STEADY)
        {
            self.errors = 0;
        }
        self.errors += 1;
        backoff_for(self.errors)
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::{answering, failure};
    use crate::ownership::KindKey;

    /// A list that answers and a watch that fails at once is not a
    /// recovery. Fails if a list starts the wait over, which listed every
    /// kind again every second for as long as its watch kept failing.
    #[test]
    fn a_watch_that_fails_right_after_its_list_waits_longer_each_time() {
        let start = Instant::now();
        let mut streak = Streak::default();
        let waits: Vec<Duration> = (0..4u64)
            .map(|n| {
                streak.live(start + Duration::from_secs(n * 10));
                streak.failed(start + Duration::from_secs(n * 10 + 1))
            })
            .collect();
        assert_eq!(waits, [1, 2, 4, 8].map(Duration::from_secs));
    }

    /// A watch that served for a while and broke once is one failure, not
    /// the next of every failure since the index started.
    #[test]
    fn a_watch_that_stayed_live_waits_from_the_first_rung() {
        let start = Instant::now();
        let mut streak = Streak::default();
        for _ in 0..5 {
            streak.failed(start);
        }
        streak.live(start);
        assert_eq!(streak.failed(start + STEADY), Duration::from_secs(1));
    }

    fn list(resource_version: &str) -> (u16, String) {
        (
            200,
            serde_json::json!({
                "apiVersion": "meta.k8s.io/v1",
                "kind": "PartialObjectMetadataList",
                "metadata": { "resourceVersion": resource_version },
                "items": [{
                    "apiVersion": "meta.k8s.io/v1",
                    "kind": "PartialObjectMetadata",
                    "metadata": {
                        "name": "api", "namespace": "shop", "uid": "u1",
                        "resourceVersion": resource_version,
                    },
                }],
            })
            .to_string(),
        )
    }

    /// A VPN reconnect broke every watch once; kube resumed each from where
    /// it was and said nothing, so every kind read "stale since" for as long
    /// as the index ran and no Delete could say nothing was hidden. Fails if
    /// a watch that broke is not read live again once the cluster answers.
    #[tokio::test]
    async fn a_watch_that_broke_once_is_live_again_when_the_cluster_answers() {
        let (client, _) = answering(|path, nth| match (path, nth) {
            ("/api/v1/pods", 1 | 3) => list("5"),
            ("/api/v1/pods", 2) => failure(500, "InternalError"),
            ("/api/v1/pods", _) => (200, String::new()),
            _ => (404, "{}".to_string()),
        })
        .await;
        let pods = KindKey {
            group: String::new(),
            plural: "pods".to_string(),
        };
        let index = ClusterIndex::holding(client, &[("Pod", pods.clone())]);
        let slot = SlotKey {
            kind: pods,
            namespace: None,
        };
        let resource = ApiResource {
            group: String::new(),
            version: "v1".to_string(),
            api_version: "v1".to_string(),
            kind: "Pod".to_string(),
            plural: "pods".to_string(),
        };
        let state = || index.slots.lock().get(&slot).cloned();

        spawn(&index, slot.clone(), resource);
        let mut seen = Vec::new();
        for _ in 0..400 {
            let now = state();
            if seen.last() != Some(&now) {
                seen.push(now.clone());
            }
            if matches!(now, Some(SlotState::Live)) && seen.len() > 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        index.stop.cancel();

        assert!(
            seen.iter()
                .any(|state| matches!(state, Some(SlotState::Stale { .. }))),
            "the watch never broke: {seen:?}"
        );
        assert_eq!(seen.last(), Some(&Some(SlotState::Live)), "{seen:?}");
    }
}
