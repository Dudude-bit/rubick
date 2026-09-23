//! Collect `kube::runtime::watcher::Event<K>` into the frontend-facing
//! `AppEvent::ResourceWatchEvent` batches. Centralised here so the
//! op-tag mapping (Apply / Delete / Init* / `InitDone`) and the batching
//! rule live in one place.

use crate::state::perf::IPC_TARGET_BYTES;
use crate::state::{AppEvent, WatchChange, WatchOp};
use kube::runtime::watcher::Event;
use serde::Serialize;
use std::time::Duration;
use tokio::sync::broadcast;

/// Longest a change waits for company before it goes out. Same 50ms as
/// the log streamer, for the same reason: one Tauri event per watch
/// event is one JS task per watch event, and React cannot batch renders
/// across separate tasks. A thousand-object resync arrived as a
/// thousand renders of a table that rebuilt its whole row model each
/// time — and as a thousand slots in a broadcast channel that holds a
/// thousand, which is what makes `event-bridge-lagged` fire.
pub(super) const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// Changes buffered before a flush is forced regardless of the timer.
/// Bounds the size of a single IPC payload — a resource is orders of
/// magnitude larger than a log line, so this is well below the log
/// streamer's line budget while still collapsing a burst by ~200x.
const MAX_BATCH_SIZE: usize = 200;

/// The changes seen since the last flush, for one stream.
pub(super) struct WatchBatch {
    stream_id: String,
    changes: Vec<WatchChange>,
    /// What the buffered resources come to on the wire. A count alone let
    /// two hundred custom resources with 50 kB statuses leave as one 10 MB
    /// event.
    bytes: usize,
}

impl WatchBatch {
    pub(super) fn new(stream_id: String) -> Self {
        Self {
            stream_id,
            changes: Vec::new(),
            bytes: 0,
        }
    }

    /// Fold one watcher event into the batch.
    ///
    /// `transform` converts a resource of kind `K` into the shape the
    /// frontend cache holds; returning `None` drops the change instead
    /// of sending a resource-less `applied` the frontend can only
    /// ignore.
    ///
    /// Returns `true` when the batch has to go out now rather than wait
    /// for the timer.
    pub(super) fn push<K, F, U>(&mut self, event: Event<K>, transform: &F) -> bool
    where
        F: Fn(&K) -> Option<U>,
        U: Serialize,
    {
        let (op, obj) = match event {
            Event::Apply(obj) | Event::InitApply(obj) => (WatchOp::Applied, obj),
            Event::Delete(obj) => (WatchOp::Deleted, obj),
            Event::Init => {
                // Start of a (re)sync: everything up to `InitDone` is the
                // complete new state. Announced before the burst rather
                // than after it so the frontend knows the rows it is
                // holding are about to be replaced wholesale.
                self.marker(WatchOp::Restarted);
                return false;
            }
            Event::InitDone => {
                // The frontend is showing pre-resync rows until this
                // arrives, so it does not wait out a flush interval.
                self.marker(WatchOp::Synced);
                return true;
            }
        };

        let Some(resource) = transform(&obj).and_then(|r| serde_json::value::to_raw_value(&r).ok())
        else {
            return false;
        };
        self.bytes += resource.get().len();
        self.changes.push(WatchChange {
            op,
            resource: Some(resource),
        });
        self.changes.len() >= MAX_BATCH_SIZE || self.bytes >= IPC_TARGET_BYTES
    }

    fn marker(&mut self, op: WatchOp) {
        self.changes.push(WatchChange { op, resource: None });
    }

    /// Send everything buffered as one event. No-op when empty, so
    /// every exit path can call it unconditionally.
    pub(super) fn flush(&mut self, event_tx: &broadcast::Sender<AppEvent>) {
        if self.changes.is_empty() {
            return;
        }
        self.bytes = 0;
        let _ = event_tx.send(AppEvent::ResourceWatchEvent {
            stream_id: self.stream_id.clone(),
            changes: std::mem::take(&mut self.changes),
            error: None,
        });
    }
}

/// Tell the frontend this watch has stopped working. Its own event
/// rather than a change in a batch: the frontend must not touch the
/// cache for it, only drop the "live" badge and start polling.
pub(super) fn emit_failure(event_tx: &broadcast::Sender<AppEvent>, stream_id: &str, error: String) {
    let _ = event_tx.send(AppEvent::ResourceWatchEvent {
        stream_id: stream_id.to_string(),
        changes: vec![WatchChange {
            op: WatchOp::Failed,
            resource: None,
        }],
        error: Some(error),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::ConfigMap;

    fn named(name: &str) -> ConfigMap {
        ConfigMap {
            metadata: kube::core::ObjectMeta {
                name: Some(name.to_string()),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// Feeds the events through a batch exactly as the watcher loop
    /// does — flushing when `push` says to, once at the end — and
    /// returns what the frontend would receive, one `Vec` per event.
    fn batches_for(events: Vec<Event<ConfigMap>>) -> Vec<Vec<WatchOp>> {
        batches_with(events, |c: &ConfigMap| c.metadata.name.clone())
    }

    fn batches_with<F, U>(events: Vec<Event<ConfigMap>>, transform: F) -> Vec<Vec<WatchOp>>
    where
        F: Fn(&ConfigMap) -> Option<U>,
        U: Serialize,
    {
        let (tx, mut rx) = broadcast::channel(32);
        let mut batch = WatchBatch::new("s1".to_string());
        for event in events {
            if batch.push(event, &transform) {
                batch.flush(&tx);
            }
        }
        batch.flush(&tx);
        drop(tx);

        let mut batches = Vec::new();
        while let Ok(AppEvent::ResourceWatchEvent { changes, .. }) = rx.try_recv() {
            batches.push(changes.into_iter().map(|c| c.op).collect());
        }
        batches
    }

    /// A resync is bracketed: `restarted` opens it, `synced` closes it.
    /// Without the closing marker the frontend has no moment at which
    /// the staged state is known to be complete, and its only options
    /// are to clear the list up front — which renders "no resources"
    /// over a healthy cluster for the length of the burst — or to never
    /// drop the objects the resync removed.
    #[test]
    fn resync_is_bracketed_by_restarted_and_synced() {
        let batches = batches_for(vec![
            Event::Init,
            Event::InitApply(named("a")),
            Event::InitApply(named("b")),
            Event::InitDone,
        ]);

        assert_eq!(
            batches,
            vec![vec![
                WatchOp::Restarted,
                WatchOp::Applied,
                WatchOp::Applied,
                WatchOp::Synced,
            ]],
            "the whole resync must arrive as one event, in order"
        );
    }

    #[test]
    fn steady_state_events_map_to_applied_and_deleted() {
        let batches = batches_for(vec![Event::Apply(named("a")), Event::Delete(named("a"))]);
        assert_eq!(batches, vec![vec![WatchOp::Applied, WatchOp::Deleted]]);
    }

    /// A burst longer than the buffer is cut into batches rather than
    /// held: the whole point is bounded payloads, not one giant one.
    #[test]
    fn a_burst_past_the_buffer_flushes_without_waiting() {
        let mut events = vec![Event::Init];
        events.extend((0..MAX_BATCH_SIZE + 5).map(|i| Event::InitApply(named(&format!("cm-{i}")))));
        events.push(Event::InitDone);

        let batches = batches_for(events);
        assert_eq!(batches.len(), 2, "one full batch, then the remainder");
        assert_eq!(batches[0].len(), MAX_BATCH_SIZE);
        assert_eq!(batches[1].last(), Some(&WatchOp::Synced));
    }

    /// Would break if the batch counted only changes: two hundred objects
    /// with large statuses left as one event of several megabytes, past the
    /// 1 MiB an IPC message may be.
    #[test]
    fn large_objects_flush_by_size_before_the_count() {
        let big = |i: usize| {
            let mut map = named(&format!("cm-{i}"));
            map.data = Some(std::collections::BTreeMap::from([(
                "blob".to_string(),
                "x".repeat(64 * 1024),
            )]));
            map
        };
        let events = (0..20).map(|i| Event::Apply(big(i))).collect();

        let batches = batches_with(events, |c: &ConfigMap| Some(c.clone()));
        assert!(batches.len() >= 4, "cut by size: {} batches", batches.len());
        assert!(batches
            .iter()
            .all(|batch| batch.len() <= IPC_TARGET_BYTES / (64 * 1024) + 1));
    }

    /// A transform that drops the resource (system pods, kinds the UI
    /// filters) must drop the change with it. Sending `applied` with a
    /// null resource spends an IPC hop on something the frontend can
    /// only ignore.
    #[test]
    fn a_dropped_resource_emits_no_change() {
        let batches = batches_with(
            vec![Event::Apply(named("a")), Event::Apply(named("b"))],
            |_: &ConfigMap| None::<String>,
        );
        assert!(batches.is_empty(), "nothing to say, so nothing is sent");
    }
}
