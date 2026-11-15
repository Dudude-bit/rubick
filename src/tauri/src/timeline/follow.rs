//! The recorder's feed: the shared watches of the followed kinds and the
//! cluster's events, and, while a timeline is on screen, what the ownership
//! index reads by name of every other kind. One follower, for the cluster on
//! screen, lives as long as its subscription.

use std::sync::Arc;

use kube::api::DynamicObject;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::project::{followed_by, FOLLOWED};
use super::recorder::{Named, Recorder, Sight, Slot, SlotState};
use super::spans::{Source, HEARTBEAT_MS};
use super::ClusterTimeline;
use crate::feeds::{Ask, Binding, FeedState, Subscription, Update, Whole};
use crate::ownership::{KindKey, News, SlotKey};

/// What the window tells a running follower.
pub(crate) enum Control {
    Rescope(Option<Vec<String>>),
    /// The ownership index's news, from now until it stops.
    Meta(mpsc::UnboundedReceiver<News>),
}

/// The follower of one context, as `Timelines` holds it.
pub(crate) struct Follower {
    pub context: String,
    pub control: mpsc::UnboundedSender<Control>,
    stop: CancellationToken,
}

impl Drop for Follower {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// Every kind the followed watches read: the followed kinds and Event.
#[must_use]
pub fn followed_kinds() -> Vec<KindKey> {
    FOLLOWED
        .iter()
        .map(|followed| KindKey {
            group: followed.group.to_string(),
            plural: followed.plural.to_string(),
        })
        .chain([KindKey {
            group: String::new(),
            plural: "events".to_string(),
        }])
        .collect()
}

/// What the timeline asks the shared watches for: every followed kind, for
/// the whole session, across the cluster and in `scope` where the cluster
/// refuses one across it. The window's namespaces narrow nothing it records.
#[must_use]
pub fn ask(scope: Option<Vec<String>>) -> Ask {
    Ask {
        kinds: followed_kinds(),
        scope,
        narrow: false,
        binding: Binding::Session,
    }
}

fn is_events(kind: &KindKey) -> bool {
    kind.group.is_empty() && kind.plural == "events"
}

/// The name a slot of a followed kind goes by on a span.
fn followed_name(kind: &KindKey) -> Option<&'static str> {
    if is_events(kind) {
        return Some("Event");
    }
    followed_by(&kind.group, &kind.plural).map(|followed| followed.kind)
}

/// The name a slot read by name only goes by: discovery's own.
fn named_label(kind: &KindKey) -> String {
    if kind.group.is_empty() {
        kind.plural.clone()
    } else {
        format!("{}.{}", kind.plural, kind.group)
    }
}

fn millis(rfc3339: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .ok()
        .map(|at| at.timestamp_millis())
}

fn value_of(object: &DynamicObject) -> Option<Value> {
    serde_json::to_value(object).ok()
}

fn event_of(object: &DynamicObject) -> Option<k8s_openapi::api::core::v1::Event> {
    serde_json::from_value(value_of(object)?).ok()
}

/// One update of the followed watches, into rows and spans.
pub(crate) fn feed(recorder: &mut Recorder, update: Update) {
    match update {
        Update::State { slot, state } => {
            let Some(kind) = followed_name(&slot.kind) else {
                return;
            };
            let (state, since) = match state {
                FeedState::Syncing | FeedState::Queued => (SlotState::Listing, None),
                FeedState::Synced => (SlotState::Live, None),
                FeedState::Blind { since } => (SlotState::Blind, millis(&since)),
                FeedState::Refused { .. } => (SlotState::Refused, None),
                FeedState::Failed { .. } => (SlotState::Blind, None),
                FeedState::Unserved => {
                    recorder.forget(Source::Followed, kind);
                    return;
                }
            };
            let slot = Slot {
                kind: kind.to_string(),
                namespace: slot.namespace,
            };
            // A watch that is live and lists again for this reader alone, a
            // kind the layer keeps nothing of after a lost update, still
            // watches: its changes wait and come after the list. Not a gap.
            let live = recorder.slot_state(Source::Followed, &slot) == Some(SlotState::Live);
            if live && state == SlotState::Listing {
                return;
            }
            recorder.state(Source::Followed, slot, state, since);
        }
        Update::Whole { slot, why, objects } => {
            if is_events(&slot.kind) {
                for event in objects.iter().filter_map(|object| event_of(object)) {
                    recorder.event(&event);
                }
                return;
            }
            let Some(followed) = followed_by(&slot.kind.group, &slot.kind.plural) else {
                return;
            };
            let values: Vec<Value> = objects.iter().filter_map(|o| value_of(o)).collect();
            // A relist, a list turn, a lost update and a new client's list
            // are all compared with what was held; only the first is not.
            recorder.listed(
                followed,
                slot.namespace.as_deref(),
                &values,
                why == Whole::Fresh,
            );
        }
        Update::Applied { slot, object } => {
            if is_events(&slot.kind) {
                if let Some(event) = event_of(&object) {
                    recorder.event(&event);
                }
                return;
            }
            if let (Some(followed), Some(value)) = (
                followed_by(&slot.kind.group, &slot.kind.plural),
                value_of(&object),
            ) {
                recorder.applied(followed, slot.namespace.as_deref(), &value);
            }
        }
        // An event the cluster let go of is still what happened.
        Update::Deleted { slot, .. } if is_events(&slot.kind) => {}
        Update::Deleted { slot, object } => {
            if let (Some(followed), Some(value)) = (
                followed_by(&slot.kind.group, &slot.kind.plural),
                value_of(&object),
            ) {
                recorder.deleted(followed, slot.namespace.as_deref(), &value);
            }
        }
        Update::HandedOver => {}
    }
}

fn index_state(state: &crate::ownership::SlotState) -> (SlotState, Option<i64>) {
    use crate::ownership::SlotState as Index;
    match state {
        Index::Queued | Index::Syncing => (SlotState::Listing, None),
        Index::Live | Index::Listed { .. } => (SlotState::Live, None),
        Index::Stale { since } => (SlotState::Blind, millis(since)),
        Index::Refused { .. } => (SlotState::Refused, None),
        Index::Failed { .. } => (SlotState::Blind, None),
    }
}

/// One piece of the ownership index's news, for the kinds it alone reads.
pub(crate) fn hear(recorder: &mut Recorder, news: News) {
    match news {
        News::State { slot, state } => {
            if followed_name(&slot.kind).is_some() {
                return;
            }
            let SlotKey { kind, namespace } = slot;
            let (state, since) = index_state(&state);
            let slot = Slot {
                kind: named_label(&kind),
                namespace,
            };
            recorder.state(Source::Meta, slot, state, since);
        }
        News::Seen { uid, node, sight } => {
            let item = Named {
                kind: node.kind,
                group: node.key.group,
                uid,
                name: node.name,
                namespace: node.namespace,
                generation: node.generation,
                controlled: node.owners.iter().any(|owner| owner.controller),
            };
            let sight = match sight {
                crate::ownership::Sight::First => Sight::First,
                crate::ownership::Sight::Relist => Sight::Relist,
                crate::ownership::Sight::Watched => Sight::Watched,
            };
            recorder.named_seen(&item, sight);
        }
        News::Gone { uid, relisted } => recorder.named_gone(&uid, relisted),
        News::Retired { kind } => recorder.forget(Source::Meta, &named_label(&kind)),
    }
}

async fn next_news(meta: &mut Option<mpsc::UnboundedReceiver<News>>) -> Option<News> {
    match meta {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Starts following one context: what the subscription hands over becomes
/// rows and spans until it ends, the follower is dropped, or the cluster
/// disconnects.
pub(crate) fn spawn(
    context: String,
    timeline: Arc<ClusterTimeline>,
    subscription: Subscription,
) -> Follower {
    let stop = CancellationToken::new();
    let (control, mut controls) = mpsc::unbounded_channel();
    let Subscription { mut updates, lease } = subscription;
    let mut recorder = Recorder::new(timeline);
    // Every kind asked for holds the span shut until its watch has spoken.
    for kind in followed_kinds() {
        if let Some(name) = followed_name(&kind) {
            let slot = Slot {
                kind: name.to_string(),
                namespace: None,
            };
            recorder.state(Source::Followed, slot, SlotState::Listing, None);
        }
    }
    let stopping = stop.clone();
    tokio::spawn(async move {
        let mut meta: Option<mpsc::UnboundedReceiver<News>> = None;
        let mut beat = tokio::time::interval(std::time::Duration::from_millis(
            u64::try_from(HEARTBEAT_MS).unwrap_or(30_000),
        ));
        beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                () = stopping.cancelled() => break,
                update = updates.recv() => match update {
                    Some(update) => feed(&mut recorder, update),
                    None => break,
                },
                control = controls.recv() => match control {
                    Some(Control::Rescope(scope)) => lease.rescope(scope),
                    Some(Control::Meta(rx)) => meta = Some(rx),
                    None => break,
                },
                news = next_news(&mut meta) => {
                    if let Some(news) = news {
                        hear(&mut recorder, news);
                    } else {
                        meta = None;
                        recorder.meta_ended();
                    }
                }
                _ = beat.tick() => recorder.heartbeat(),
            }
        }
        recorder.stop();
    });
    Follower {
        context,
        control,
        stop,
    }
}
