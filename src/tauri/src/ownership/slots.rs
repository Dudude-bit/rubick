//! One metadata-only watch per kind, or per kind and namespace where the
//! cluster refused the kind across it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use kube::api::{Api, DynamicObject};
use kube::core::PartialObjectMeta;
use kube::discovery::ApiResource;
use kube::runtime::watcher::{self, Event};
use tokio_util::sync::CancellationToken;
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
        index.refused(&slot, message, None);
        return;
    }
    let stop = index.stop.child_token();
    let free = index.watches.clone().try_acquire_owned().ok();
    {
        let mut slots = index.slots.lock();
        let mut stops = index.stops.lock();
        if stops.contains_key(&slot) {
            return;
        }
        stops.insert(slot.clone(), stop.clone());
        let state = if free.is_some() {
            SlotState::Syncing
        } else {
            SlotState::Queued
        };
        slots.insert(slot.clone(), state);
    }
    let index = index.clone();
    tokio::spawn(async move {
        let _watching = if let Some(permit) = free {
            permit
        } else {
            let freed = tokio::select! {
                biased;
                () = stop.cancelled() => return,
                freed = index.watches.clone().acquire_owned() => freed,
            };
            let Ok(permit) = freed else { return };
            index.started(&slot, &stop);
            permit
        };
        let api: Api<Meta> = match &slot.namespace {
            Some(namespace) => Api::namespaced_with(index.client.clone(), namespace, &resource),
            None => Api::all_with(index.client.clone(), &resource),
        };
        let config = watcher::Config::default()
            .page_size(PAGE_SIZE)
            .timeout(WATCH_TIMEOUT_SECS);
        let mut failures = Streak::default();
        // After a failure the kind is listed afresh: kube's resumed watch says
        // nothing when it succeeds, so the slot stayed stale for good.
        'list: loop {
            let stream = watcher::watcher(api.clone(), config.clone());
            futures::pin_mut!(stream);
            loop {
                let next = tokio::select! {
                    biased;
                    () = stop.cancelled() => break 'list,
                    next = stream.next() => next,
                };
                match next {
                    Some(Ok(event)) => {
                        if matches!(event, Event::InitDone) {
                            failures.live(Instant::now());
                        }
                        index.saw(&slot, &resource, event, &stop);
                    }
                    Some(Err(error)) => {
                        let message = watch_failure(&error);
                        if refused(&error) {
                            told_refused(&slot);
                            index.refused(&slot, message, Some(&stop));
                            break 'list;
                        }
                        if gone(&error) {
                            index.retire(&slot.kind);
                            break 'list;
                        }
                        index.failed(&slot, message, &stop);
                        tokio::select! {
                            biased;
                            () = stop.cancelled() => break 'list,
                            () = tokio::time::sleep(failures.failed(Instant::now())) => {}
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

/// The cluster no longer serves the kind: its CRD was deleted.
fn gone(error: &watcher::Error) -> bool {
    use watcher::Error as Watch;
    matches!(
        error,
        Watch::InitialListFailed(kube::Error::Api(status))
            | Watch::WatchStartFailed(kube::Error::Api(status)) if status.code == 404
    )
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
    /// Every write a watch makes checks its stop under the slots' lock, which
    /// is the lock a namespace leaving the scope drops the slot under.
    fn saw(
        &self,
        slot: &SlotKey,
        resource: &ApiResource,
        event: Event<Meta>,
        stop: &CancellationToken,
    ) {
        let mut slots = self.slots.lock();
        if stop.is_cancelled() {
            return;
        }
        let mut graph = self.graph.write();
        match event {
            // The marker comes before a list that may still fail: what a
            // broken watch held stays stale until the list has answered.
            Event::Init => {
                graph.relist(slot);
                if !matches!(slots.get(slot), Some(SlotState::Stale { .. })) {
                    slots.insert(slot.clone(), SlotState::Syncing);
                }
            }
            Event::InitApply(meta) | Event::Apply(meta) => {
                if let Some((uid, node)) = node_of(&meta, resource) {
                    graph.apply(slot, uid, node);
                }
            }
            Event::InitDone => {
                graph.listed(slot);
                slots.insert(slot.clone(), SlotState::Live);
            }
            Event::Delete(meta) => {
                if let Some(uid) = meta.metadata.uid.as_deref() {
                    graph.delete(slot, uid);
                }
            }
        }
    }

    /// A watch that waited for a free one has it and starts listing.
    fn started(&self, slot: &SlotKey, stop: &CancellationToken) {
        let mut slots = self.slots.lock();
        if !stop.is_cancelled() {
            slots.insert(slot.clone(), SlotState::Syncing);
        }
    }

    /// A kind the cluster stopped serving holds nothing and is no longer one
    /// of the kinds: it is neither read nor named as not read.
    fn retire(&self, kind: &super::KindKey) {
        self.watched.lock().remove(kind);
        let mut slots = self.slots.lock();
        let mut stops = self.stops.lock();
        let mut graph = self.graph.write();
        slots.retain(|slot, _| {
            if slot.kind != *kind {
                return true;
            }
            if let Some(stop) = stops.remove(slot) {
                stop.cancel();
            }
            graph.drop_slot(slot);
            false
        });
    }

    /// A live watch that breaks keeps what it held, marked as of now; one
    /// that never listed has nothing to keep.
    fn failed(&self, slot: &SlotKey, message: String, stop: &CancellationToken) {
        let mut slots = self.slots.lock();
        if stop.is_cancelled() {
            return;
        }
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
    fn refused(
        self: &Arc<Self>,
        slot: &SlotKey,
        message: String,
        stop: Option<&CancellationToken>,
    ) {
        self.refusals.lock().insert(slot.clone(), message.clone());
        {
            let mut slots = self.slots.lock();
            if stop.is_some_and(CancellationToken::is_cancelled) {
                return;
            }
            self.stops.lock().remove(slot);
            self.graph.write().drop_slot(slot);
            slots.insert(slot.clone(), SlotState::Refused { message });
        }
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

    /// A watch's last event can land while its namespace leaves the scope;
    /// written after, it put back a slot nothing would stop again. Fails if
    /// a watch whose stop was taken writes anything.
    #[tokio::test]
    async fn a_watch_stopped_by_the_scope_writes_nothing_more() {
        let (client, _) = answering(|_, _| (404, "{}".to_string())).await;
        let index = ClusterIndex::holding(client, &[]);
        let slot = SlotKey {
            kind: KindKey {
                group: String::new(),
                plural: "pods".to_string(),
            },
            namespace: Some("web".to_string()),
        };
        let resource = ApiResource::erase::<k8s_openapi::api::core::v1::Pod>(&());
        let stop = CancellationToken::new();
        stop.cancel();

        let written = || std::mem::take(&mut *index.slots.lock()).len();
        index.saw(&slot, &resource, Event::InitDone, &stop);
        let listed = written();
        index.failed(&slot, "reset".to_string(), &stop);
        let failed = written();
        index.refused(&slot, "forbidden".to_string(), Some(&stop));
        let refused = written();

        assert_eq!((listed, failed, refused), (0, 0, 0));
    }

    fn pods() -> (SlotKey, ApiResource) {
        (
            SlotKey {
                kind: KindKey {
                    group: String::new(),
                    plural: "pods".to_string(),
                },
                namespace: None,
            },
            ApiResource::erase::<k8s_openapi::api::core::v1::Pod>(&()),
        )
    }

    fn configmaps() -> (SlotKey, ApiResource) {
        (
            SlotKey {
                kind: KindKey {
                    group: String::new(),
                    plural: "configmaps".to_string(),
                },
                namespace: None,
            },
            ApiResource::erase::<k8s_openapi::api::core::v1::ConfigMap>(&()),
        )
    }

    /// The marker of a new list comes before the list, which may fail again:
    /// taken for an answer, it turned "stale since 14:02" into "still
    /// listing" and then "failed" while the cluster stayed away. Fails if a
    /// stale kind stops being stale before its list has answered.
    #[tokio::test]
    async fn a_broken_watch_stays_stale_until_its_new_list_has_answered() {
        let (client, _) = answering(|_, _| (404, "{}".to_string())).await;
        let (slot, resource) = pods();
        let index = ClusterIndex::holding(client, &[("Pod", slot.kind.clone())]);
        let stop = CancellationToken::new();
        let state = || index.slots.lock().get(&slot).cloned();

        index.saw(&slot, &resource, Event::InitDone, &stop);
        index.failed(&slot, "reset".to_string(), &stop);
        let broken = state();
        assert!(
            matches!(broken, Some(SlotState::Stale { .. })),
            "{broken:?}"
        );

        index.saw(&slot, &resource, Event::Init, &stop);
        index.failed(&slot, "reset".to_string(), &stop);
        assert_eq!(state(), broken);

        index.saw(&slot, &resource, Event::Init, &stop);
        index.saw(&slot, &resource, Event::InitDone, &stop);
        assert_eq!(state(), Some(SlotState::Live));
    }

    /// A watch per kind, and per namespace for each refused kind, each on a
    /// connection of its own, had no ceiling: a few hundred took every file
    /// the process may open. Fails if a watch starts with none free, or if
    /// one that waits is read as anything but waiting, or never starts.
    #[tokio::test]
    async fn a_watch_past_the_ceiling_waits_for_a_free_one_and_says_so() {
        let (client, hits) = answering(|path, nth| match (path, nth) {
            ("/api/v1/pods", _) => failure(403, "Forbidden"),
            ("/api/v1/configmaps", 1) => list("5"),
            _ => (200, String::new()),
        })
        .await;
        let ((first, pods), (second, maps)) = (pods(), configmaps());
        let index = ClusterIndex::holding(
            client,
            &[
                ("Pod", first.kind.clone()),
                ("ConfigMap", second.kind.clone()),
            ],
        );
        index
            .watches
            .forget_permits(index.watches.available_permits() - 1);
        let reading = || crate::ownership::reading_of(&second.kind, &index.slots.lock().clone());

        // Held by the test, so the second watch waits for as long as it looks.
        let held = index.watches.clone().try_acquire_owned().expect("free");
        spawn(&index, second.clone(), maps);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(reading(), Some(crate::ownership::Reading::Queued));
        assert_eq!(hits.lock().unwrap().get("/api/v1/configmaps"), None);

        // A refused watch gives its place up.
        drop(held);
        spawn(&index, first, pods);
        for _ in 0..300 {
            if reading().is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(reading(), None);
        index.stop.cancel();
    }

    /// A deleted CRD's kind answered 404 to every list, for ever, and stood
    /// among the kinds not read where no object of it can exist. Fails if a
    /// kind the cluster no longer serves is still watched or still named.
    #[tokio::test]
    async fn a_kind_the_cluster_stopped_serving_is_no_longer_one_of_the_kinds() {
        let (client, hits) = answering(|_, _| failure(404, "NotFound")).await;
        let (slot, resource) = pods();
        let index = ClusterIndex::holding(client, &[("Pod", slot.kind.clone())]);

        spawn(&index, slot.clone(), resource);
        for _ in 0..300 {
            if index.kinds().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(1200)).await;

        assert!(index.kinds().is_empty());
        assert!(index.slots.lock().is_empty());
        assert_eq!(index.not_read().kinds, []);
        assert_eq!(hits.lock().unwrap().get("/api/v1/pods"), Some(&1));
        index.stop.cancel();
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
