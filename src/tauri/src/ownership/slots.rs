//! One metadata-only watch per kind, or per kind and namespace where the
//! cluster refused the kind across it. With no watch free a kind is read by
//! that watch's list alone, a turn at a time, until one is.

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
use super::{ClusterIndex, SlotState, RELIST_EVERY, TURN_PAUSE};
use crate::error::watch_failure;
use crate::watch::backoff_for;

/// Just under the five minutes an API server allows a watch.
const WATCH_TIMEOUT_SECS: u32 = 290;
const PAGE_SIZE: u32 = 500;

type Meta = PartialObjectMeta<DynamicObject>;

pub(super) fn spawn(index: &Arc<ClusterIndex>, slot: SlotKey, resource: ApiResource) {
    spawn_relisting(index, slot, resource, RELIST_EVERY);
}

/// The wait between turns is a parameter so a test can use one it can wait out.
fn spawn_relisting(
    index: &Arc<ClusterIndex>,
    slot: SlotKey,
    resource: ApiResource,
    relist_every: Duration,
) {
    let known = index.refusals.lock().get(&slot).cloned();
    if let Some(message) = known {
        index.refused(&slot, message, None);
        return;
    }
    let stop = index.stop.child_token();
    let mut watch = index.watches.clone().try_acquire_owned().ok();
    {
        let mut slots = index.slots.lock();
        let mut stops = index.stops.lock();
        if stops.contains_key(&slot) {
            return;
        }
        stops.insert(slot.clone(), stop.clone());
        let state = if watch.is_some() {
            SlotState::Syncing
        } else {
            SlotState::Queued
        };
        slots.insert(slot.clone(), state);
    }
    let index = index.clone();
    tokio::spawn(async move {
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
            // A watch held for life left every kind past the ceiling unread
            // for good: without one, the kind takes a turn at being listed.
            let turn = if watch.is_some() {
                None
            } else {
                tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    Ok(freed) = index.watches.clone().acquire_owned() => {
                        watch = Some(freed);
                        None
                    }
                    Ok(turn) = index.turns.clone().acquire_owned() => Some(turn),
                    else => break,
                }
            };
            let wait = {
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
                            let listed = matches!(event, Event::InitDone);
                            if listed {
                                failures.live(Instant::now());
                            }
                            index.saw(&slot, &resource, event, &stop);
                            // The stream's next step opens the watch.
                            if listed && watch.is_none() {
                                index.listed(&slot, &stop);
                                break relist_every;
                            }
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
                            break failures.failed(Instant::now());
                        }
                        None => break 'list,
                    }
                }
            };
            if turn.is_some() {
                tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    () = tokio::time::sleep(TURN_PAUSE) => {}
                }
            }
            drop(turn);
            tokio::select! {
                biased;
                () = stop.cancelled() => break,
                Ok(freed) = index.watches.clone().acquire_owned(), if watch.is_none() => {
                    watch = Some(freed);
                }
                () = tokio::time::sleep(wait) => {}
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
                if !matches!(
                    slots.get(slot),
                    Some(SlotState::Stale { .. } | SlotState::Listed { .. })
                ) {
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

    /// A list with no watch behind it has answered: what the slot holds is
    /// from now, until its next turn.
    fn listed(&self, slot: &SlotKey, stop: &CancellationToken) {
        let mut slots = self.slots.lock();
        if !stop.is_cancelled() {
            let at = chrono::Utc::now();
            slots.insert(slot.clone(), SlotState::Listed { at });
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

    /// A live watch that breaks keeps what it held, marked as of now, and a
    /// list as of when it answered; one that never listed has nothing to keep.
    fn failed(&self, slot: &SlotKey, message: String, stop: &CancellationToken) {
        let mut slots = self.slots.lock();
        if stop.is_cancelled() {
            return;
        }
        let next = match slots.get(slot) {
            Some(SlotState::Live) => SlotState::Stale {
                since: chrono::Utc::now().to_rfc3339(),
            },
            Some(SlotState::Listed { at }) => SlotState::Stale {
                since: at.to_rfc3339(),
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
        index.listed(&slot, &stop);
        let dated = written();

        assert_eq!((listed, failed, refused, dated), (0, 0, 0, 0));
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

    /// Every kind was listed and watched whole: opening Delete pulled each
    /// Helm release Secret and `ConfigMap` in full to keep its metadata. Fails
    /// if a list or a watch asks for more than metadata.
    #[tokio::test]
    async fn a_kind_is_listed_and_watched_as_metadata_only() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        let asked: Arc<parking_lot::Mutex<Vec<String>>> = Arc::default();
        let seen = asked.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                let first = {
                    let mut seen = seen.lock();
                    seen.push(request);
                    seen.len() == 1
                };
                let body = if first { list("5").1 } else { String::new() };
                let reply = format!(
                    "HTTP/1.1 200 X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        let client =
            kube::Client::try_from(kube::Config::new(url.parse().expect("url"))).expect("client");
        let (slot, resource) = pods();
        let index = ClusterIndex::holding(client, &[("Pod", slot.kind.clone())]);

        spawn(&index, slot, resource);
        for _ in 0..300 {
            if asked.lock().len() >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        index.stop.cancel();

        let asked = asked.lock().clone();
        assert!(asked.len() >= 2, "no list and watch: {asked:?}");
        assert!(
            asked[0].contains("as=partialobjectmetadatalist"),
            "{asked:?}"
        );
        assert!(asked[1].contains("watch=true"), "{asked:?}");
        assert!(asked[1].contains("as=partialobjectmetadata"), "{asked:?}");
    }

    /// Every watch the index may hold, taken: whatever starts next finds none.
    fn every_watch(index: &ClusterIndex) -> tokio::sync::OwnedSemaphorePermit {
        let all = u32::try_from(index.watches.available_permits()).expect("a count");
        index
            .watches
            .clone()
            .try_acquire_many_owned(all)
            .expect("every watch free")
    }

    async fn until(what: impl Fn() -> bool) {
        for _ in 0..300 {
            if what() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// The names the index holds of a kind, each in `shop`.
    fn shop(names: &[&str]) -> Vec<(String, Option<String>)> {
        names
            .iter()
            .map(|name| ((*name).to_string(), Some("shop".to_string())))
            .collect()
    }

    /// A watch per kind, and per namespace for each refused kind, each on a
    /// connection of its own, had no ceiling: a few hundred took every file
    /// the process may open. Its first ceiling kept each watch for life, so
    /// a kind past it waited for a turn that never came and was never read.
    /// Fails if a kind with no watch free is not read, or opens a watch.
    #[tokio::test]
    async fn a_kind_past_the_ceiling_is_read_by_its_list_and_opens_no_watch() {
        let (client, hits) = answering(|path, _| match path {
            "/api/v1/configmaps" => list("5"),
            _ => (200, String::new()),
        })
        .await;
        let (slot, maps) = configmaps();
        let index = ClusterIndex::holding(client, &[("ConfigMap", slot.kind.clone())]);
        let _held = every_watch(&index);

        spawn(&index, slot.clone(), maps);
        until(|| index.not_read().kinds.is_empty()).await;

        assert_eq!(index.not_read().kinds, []);
        assert_eq!(index.names(&slot.kind, None), Ok(shop(&["api"])));
        // A watch asks again as soon as this server's empty answer ends.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(hits.lock().unwrap().get("/api/v1/configmaps"), Some(&1));
        index.stop.cancel();
    }

    /// Listed once and never again, a kind with no watch kept what was
    /// deleted minutes ago and missed everything created since. Fails if its
    /// turn does not come round again.
    #[tokio::test]
    async fn a_kind_read_by_its_list_is_listed_again_on_its_next_turn() {
        let (client, _) = answering(|path, nth| match (path, nth) {
            ("/api/v1/configmaps", 1) => list("5"),
            ("/api/v1/configmaps", _) => list_naming("6", "web"),
            _ => (200, String::new()),
        })
        .await;
        let (slot, maps) = configmaps();
        let index = ClusterIndex::holding(client, &[("ConfigMap", slot.kind.clone())]);
        let _held = every_watch(&index);
        let names = || index.names(&slot.kind, None);

        spawn_relisting(&index, slot.clone(), maps, Duration::from_millis(50));
        until(|| names() == Ok(shop(&["web"]))).await;

        assert_eq!(names(), Ok(shop(&["web"])));
        index.stop.cancel();
    }

    /// A kind with no watch is asked for again and again, and a cluster that
    /// answers in milliseconds was asked as fast as it answered. Fails if a
    /// turn is given up the moment its list ends.
    #[tokio::test]
    async fn kinds_with_no_watch_are_listed_no_faster_than_their_turns_allow() {
        let (client, hits) = answering(|path, _| match path {
            "/api/v1/configmaps" => list("5"),
            _ => (200, String::new()),
        })
        .await;
        let (slot, maps) = configmaps();
        let index = ClusterIndex::holding(client, &[("ConfigMap", slot.kind.clone())]);
        let _held = every_watch(&index);

        spawn_relisting(&index, slot, maps, Duration::ZERO);
        tokio::time::sleep(TURN_PAUSE * 3).await;

        let asked = hits.lock().unwrap().get("/api/v1/configmaps").copied();
        assert!(asked.is_some_and(|lists| lists <= 3), "{asked:?}");
        index.stop.cancel();
    }

    /// Fails if a kind read by its list goes on being listed once a watch
    /// is free: a cluster left behind gives its watches up after three
    /// minutes, and the one on screen would poll every kind for good.
    #[tokio::test]
    async fn a_kind_read_by_its_list_takes_a_watch_when_one_comes_free() {
        let (client, _) = answering(|path, nth| match (path, nth) {
            ("/api/v1/configmaps", 1 | 2) => list("5"),
            _ => (200, String::new()),
        })
        .await;
        let (slot, maps) = configmaps();
        let index = ClusterIndex::holding(client, &[("ConfigMap", slot.kind.clone())]);
        let held = every_watch(&index);
        let state = || index.slots.lock().get(&slot).cloned();

        spawn(&index, slot.clone(), maps);
        until(|| matches!(state(), Some(SlotState::Listed { .. }))).await;
        assert!(
            matches!(state(), Some(SlotState::Listed { .. })),
            "{:?}",
            state()
        );

        drop(held);
        until(|| state() == Some(SlotState::Live)).await;
        assert_eq!(state(), Some(SlotState::Live));
        assert_eq!(
            index.watches.available_permits(),
            crate::ownership::MAX_WATCHES - 1
        );
        index.stop.cancel();
    }

    /// A kind whose turn has not come holds nothing: read as anything but
    /// waiting, it is "read, and nothing there". Fails if it says otherwise
    /// before its list, asks the cluster with no turn free, or is never
    /// listed once one is.
    #[tokio::test]
    async fn a_kind_waiting_for_its_turn_says_so_until_it_is_listed() {
        let (client, hits) = answering(|path, _| match path {
            "/api/v1/configmaps" => list("5"),
            _ => (200, String::new()),
        })
        .await;
        let (slot, maps) = configmaps();
        let index = ClusterIndex::holding(client, &[("ConfigMap", slot.kind.clone())]);
        let _held = every_watch(&index);
        let turns = u32::try_from(index.turns.available_permits()).expect("a count");
        let taken = index.turns.clone().try_acquire_many_owned(turns);
        let reading = || crate::ownership::reading_of(&slot.kind, &index.slots.lock().clone());

        spawn(&index, slot.clone(), maps);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(reading(), Some(crate::ownership::Reading::Queued));
        assert_eq!(hits.lock().unwrap().get("/api/v1/configmaps"), None);

        drop(taken);
        until(|| reading().is_none()).await;
        assert_eq!(reading(), None);
        index.stop.cancel();
    }

    /// Fails if a kind still waiting for its first turn lets a watch that
    /// came free go by: with every turn taken it would wait on, unread.
    #[tokio::test]
    async fn a_kind_waiting_for_its_turn_takes_a_watch_that_comes_free_first() {
        let (client, _) = answering(|path, nth| match (path, nth) {
            ("/api/v1/configmaps", 1) => list("5"),
            _ => (200, String::new()),
        })
        .await;
        let (slot, maps) = configmaps();
        let index = ClusterIndex::holding(client, &[("ConfigMap", slot.kind.clone())]);
        let held = every_watch(&index);
        let turns = u32::try_from(index.turns.available_permits()).expect("a count");
        let _taken = index.turns.clone().try_acquire_many_owned(turns);
        let state = || index.slots.lock().get(&slot).cloned();

        spawn(&index, slot.clone(), maps);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(state(), Some(SlotState::Queued));

        drop(held);
        until(|| state() == Some(SlotState::Live)).await;
        assert_eq!(state(), Some(SlotState::Live));
        index.stop.cancel();
    }

    /// A kind read by its list holds what that list said. Fails if the
    /// marker of its next turn reads as "still listing", which took every
    /// such kind out of the answer twice a minute, or if a turn that fails
    /// is dated by the failure rather than by the list still held.
    #[tokio::test]
    async fn a_listed_kind_keeps_its_list_through_its_next_turn_and_a_failed_one() {
        let (client, _) = answering(|_, _| (404, "{}".to_string())).await;
        let (slot, resource) = pods();
        let index = ClusterIndex::holding(client, &[("Pod", slot.kind.clone())]);
        let stop = CancellationToken::new();
        let state = || index.slots.lock().get(&slot).cloned();

        index.saw(&slot, &resource, Event::InitDone, &stop);
        index.listed(&slot, &stop);
        let Some(SlotState::Listed { at }) = state() else {
            panic!("not listed: {:?}", state());
        };

        index.saw(&slot, &resource, Event::Init, &stop);
        assert_eq!(state(), Some(SlotState::Listed { at }));

        index.failed(&slot, "reset".to_string(), &stop);
        let since = at.to_rfc3339();
        assert_eq!(state(), Some(SlotState::Stale { since }));
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
        list_naming(resource_version, "api")
    }

    /// A list of one object, `name` in `shop`.
    fn list_naming(resource_version: &str, name: &str) -> (u16, String) {
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
                        "name": name, "namespace": "shop", "uid": name,
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
