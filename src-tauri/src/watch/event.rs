//! Translate `kube::runtime::watcher::Event<K>` into the
//! frontend-facing `AppEvent::ResourceWatchEvent`. Centralised here
//! so the op-tag mapping (Apply / Delete / Init* / InitDone)
//! lives in one place.

use crate::state::{AppEvent, WatchOp};
use kube::runtime::watcher::Event;
use serde::Serialize;
use tokio::sync::broadcast;

/// Emit a single watcher event to the broadcast channel. `transform`
/// converts a resource of kind `K` to whatever shape the frontend
/// cache expects (returns `None` to drop the event).
pub(super) fn emit_event<K, F, U>(
    event_tx: &broadcast::Sender<AppEvent>,
    stream_id: &str,
    event: Event<K>,
    transform: &F,
) where
    F: Fn(&K) -> Option<U>,
    U: Serialize,
{
    match event {
        Event::Apply(obj) => send(event_tx, stream_id, WatchOp::Applied, transform(&obj)),
        Event::Delete(obj) => {
            send(event_tx, stream_id, WatchOp::Deleted, transform(&obj));
        }
        Event::Init => {
            // Start of a (re)sync: the burst of `InitApply` events that
            // follows is the complete new state, so tell the frontend to
            // drop what it has. Emitting this on `InitDone` instead would
            // wipe the cache the burst just filled.
            send::<()>(event_tx, stream_id, WatchOp::Restarted, None);
        }
        Event::InitApply(obj) => {
            send(event_tx, stream_id, WatchOp::Applied, transform(&obj));
        }
        Event::InitDone => {
            // End of the resync — the frontend cache is already current.
        }
    }
}

fn send<U: Serialize>(
    event_tx: &broadcast::Sender<AppEvent>,
    stream_id: &str,
    op: WatchOp,
    obj: Option<U>,
) {
    let resource = obj.and_then(|o| serde_json::to_value(&o).ok());
    let _ = event_tx.send(AppEvent::ResourceWatchEvent {
        stream_id: stream_id.to_string(),
        op,
        resource,
        error: None,
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

    /// Drains the channel into the op sequence the frontend would see.
    fn ops_for(events: Vec<Event<ConfigMap>>) -> Vec<WatchOp> {
        let (tx, mut rx) = broadcast::channel(32);
        let transform = |c: &ConfigMap| c.metadata.name.clone();
        for event in events {
            emit_event(&tx, "s1", event, &transform);
        }
        drop(tx);

        let mut ops = Vec::new();
        while let Ok(AppEvent::ResourceWatchEvent { op, .. }) = rx.try_recv() {
            ops.push(op);
        }
        ops
    }

    /// `restarted` clears the frontend cache, so it has to precede the
    /// `InitApply` burst. Emitting it on `InitDone` wiped the list the
    /// burst had just filled — every list page rendered empty until
    /// unrelated `Apply` heartbeats trickled rows back in.
    #[test]
    fn resync_clears_cache_before_the_burst_not_after() {
        let ops = ops_for(vec![
            Event::Init,
            Event::InitApply(named("a")),
            Event::InitApply(named("b")),
            Event::InitDone,
        ]);

        assert_eq!(
            ops,
            vec![WatchOp::Restarted, WatchOp::Applied, WatchOp::Applied],
            "restarted must come first and InitDone must emit nothing"
        );
    }

    #[test]
    fn steady_state_events_map_to_applied_and_deleted() {
        let ops = ops_for(vec![Event::Apply(named("a")), Event::Delete(named("a"))]);
        assert_eq!(ops, vec![WatchOp::Applied, WatchOp::Deleted]);
    }
}
