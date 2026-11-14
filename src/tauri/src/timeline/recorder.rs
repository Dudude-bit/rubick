//! What the watches saw, turned into rows and spans: one baseline per object
//! a followed kind holds, a row for each change after it, a row for each
//! object created or deleted, and a span while every watch is live or was
//! refused. A list after a break is compared with what was seen before it,
//! and what differs is said to have been noticed then, not seen happening.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use serde_json::Value;

use super::project::{changed, snapshot, Followed, Snapshot};
use super::spans::{Cover, Source};
use super::{ClusterTimeline, RowSays, TimelineRow};
use crate::resources::EventInfo;

/// Where one watch reads a kind: the whole cluster, or one namespace.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Slot {
    pub kind: String,
    pub namespace: Option<String>,
}

/// How one watch stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotState {
    /// Listing, first or again after a break: nothing it holds is current.
    Listing,
    Live,
    /// The cluster refused it; it is named, and holds nothing shut.
    Refused,
    /// Broken for another reason: what it would have seen is unknown.
    Blind,
}

/// The kinds the followed spans speak for are these, not Event.
const EVENT: &str = "Event";

fn key_of(object: &Value) -> Option<(Option<String>, String)> {
    let meta = object.get("metadata")?;
    let name = meta.get("name")?.as_str()?.to_string();
    let namespace = meta
        .get("namespace")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((namespace, name))
}

#[derive(Default)]
struct Objects {
    seen: HashMap<(Option<String>, String), Snapshot>,
    /// The creation time of what was deleted under each key, so a late
    /// event about it does not bring it back.
    gone: HashMap<(Option<String>, String), Option<String>>,
}

/// One object of a kind read by name only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Named {
    pub kind: String,
    pub group: String,
    pub uid: String,
    pub name: String,
    pub namespace: Option<String>,
    pub generation: Option<i64>,
    /// A controller owns it: its birth and death are its owner's story.
    pub controlled: bool,
}

pub struct Recorder {
    timeline: Arc<ClusterTimeline>,
    objects: HashMap<(&'static str, &'static str), Objects>,
    named: HashMap<String, Named>,
    slots: BTreeMap<(Source, Slot), SlotState>,
    /// The window's namespaces, where a kind refused across the cluster is
    /// read instead.
    scope: Vec<String>,
}

impl Recorder {
    #[must_use]
    pub fn new(timeline: Arc<ClusterTimeline>, scope: Vec<String>) -> Self {
        Self {
            timeline,
            objects: HashMap::new(),
            named: HashMap::new(),
            slots: BTreeMap::new(),
            scope,
        }
    }

    fn row(followed: &Followed, key: &(Option<String>, String), what: RowSays) -> TimelineRow {
        TimelineRow {
            id: String::new(),
            seq: 0,
            at: 0,
            kind: followed.kind.to_string(),
            group: followed.group.to_string(),
            namespace: key.0.clone(),
            name: key.1.clone(),
            what,
            at_relist: false,
        }
    }

    fn record(&self, mut row: TimelineRow, at_relist: bool) {
        row.at = chrono::Utc::now().timestamp_millis();
        row.at_relist = at_relist;
        self.timeline.change(row);
    }

    /// A whole list of a kind. The first is a baseline and says nothing;
    /// one after a break is compared with it, and what moved is said to
    /// have been noticed now, in the gap before.
    pub fn listed<'a>(
        &mut self,
        followed: &'static Followed,
        items: impl IntoIterator<Item = &'a Value>,
        after_break: bool,
    ) {
        let mut fresh = HashMap::new();
        for object in items {
            if let Some(key) = key_of(object) {
                fresh.insert(key, snapshot(followed, object));
            }
        }
        let objects = self
            .objects
            .entry((followed.kind, followed.group))
            .or_default();
        if !after_break {
            objects.seen = fresh;
            return;
        }
        let mut rows = Vec::new();
        for (key, next) in &fresh {
            match objects.seen.get(key) {
                Some(prev) if prev.born == next.born => {
                    if let Some(what) = changed(prev, next) {
                        rows.push(Self::row(followed, key, what));
                    }
                }
                _ => rows.push(Self::row(followed, key, RowSays::Created)),
            }
        }
        for key in objects.seen.keys() {
            if !fresh.contains_key(key) {
                rows.push(Self::row(followed, key, RowSays::Deleted));
            }
        }
        objects.seen = fresh;
        for row in rows {
            self.record(row, true);
        }
    }

    /// One object of a followed kind as it is now.
    pub fn applied(&mut self, followed: &'static Followed, object: &Value) {
        let Some(key) = key_of(object) else {
            return;
        };
        let next = snapshot(followed, object);
        let objects = self
            .objects
            .entry((followed.kind, followed.group))
            .or_default();
        let what = match objects.seen.get(&key) {
            Some(prev) if prev.born == next.born => changed(prev, &next),
            None if objects.gone.get(&key) == Some(&next.born) => None,
            _ => Some(RowSays::Created),
        };
        objects.gone.remove(&key);
        objects.seen.insert(key.clone(), next);
        if let Some(what) = what {
            self.record(Self::row(followed, &key, what), false);
        }
    }

    /// One object of a followed kind deleted.
    pub fn deleted(&mut self, followed: &'static Followed, object: &Value) {
        let Some(key) = key_of(object) else {
            return;
        };
        let objects = self
            .objects
            .entry((followed.kind, followed.group))
            .or_default();
        let Some(prev) = objects.seen.remove(&key) else {
            return;
        };
        objects.gone.insert(key.clone(), prev.born);
        self.record(Self::row(followed, &key, RowSays::Deleted), false);
    }

    fn named_row(item: &Named, what: RowSays) -> TimelineRow {
        TimelineRow {
            id: String::new(),
            seq: 0,
            at: 0,
            kind: item.kind.clone(),
            group: item.group.clone(),
            namespace: item.namespace.clone(),
            name: item.name.clone(),
            what,
            at_relist: false,
        }
    }

    /// One object of a kind read by name only, as it is now: its generation
    /// moved, or it is new. A controller's object's birth is its owner's.
    pub fn named_applied(&mut self, item: &Named, settled: bool) {
        let before = self.named.insert(item.uid.clone(), item.clone());
        let what = match before {
            Some(prev) if prev.generation != item.generation && item.generation.is_some() => {
                Some(RowSays::Generation {
                    from: prev.generation,
                    to: item.generation,
                })
            }
            None if settled && !item.controlled => Some(RowSays::Created),
            _ => None,
        };
        if let Some(what) = what {
            self.record(Self::named_row(item, what), false);
        }
    }

    /// One object of a kind read by name only, deleted.
    pub fn named_deleted(&mut self, uid: &str) {
        if let Some(item) = self.named.remove(uid) {
            if !item.controlled {
                self.record(Self::named_row(&item, RowSays::Deleted), false);
            }
        }
    }

    /// How one watch stands now. A source's span is open while every one
    /// of its watches is live or refused and one is live; a change in what
    /// was refused ends it and starts the next, which says the new refusal.
    pub fn state(&mut self, source: Source, slot: Slot, state: SlotState) {
        let was = self.cover(source);
        self.slots.insert((source, slot), state);
        let now = self.cover(source);
        if was == now {
            return;
        }
        self.timeline.spans(|spans, at| match now {
            None => spans.end(source, at),
            Some(cover) => spans.begin(source, at, cover),
        });
    }

    /// What a source's span watches now, or `None` where it is shut.
    fn cover(&self, source: Source) -> Option<Cover> {
        let slots: Vec<(&Slot, SlotState)> = self
            .slots
            .iter()
            .filter(|((of, _), _)| *of == source)
            .map(|((_, slot), state)| (slot, *state))
            .collect();
        if !slots.iter().any(|(_, state)| *state == SlotState::Live)
            || slots
                .iter()
                .any(|(_, state)| matches!(state, SlotState::Listing | SlotState::Blind))
        {
            return None;
        }
        let mut by_kind: BTreeMap<&str, Vec<(&Option<String>, SlotState)>> = BTreeMap::new();
        for (slot, state) in slots {
            by_kind
                .entry(&slot.kind)
                .or_default()
                .push((&slot.namespace, state));
        }
        let mut cover = Cover::default();
        let mut narrowed = false;
        let mut refused_in = BTreeSet::new();
        for (kind, slots) in by_kind {
            let live = slots.iter().any(|(_, state)| *state == SlotState::Live);
            let wide = slots
                .iter()
                .any(|(namespace, state)| namespace.is_none() && *state == SlotState::Live);
            if live {
                refused_in.extend(
                    slots
                        .iter()
                        .filter(|(_, state)| *state == SlotState::Refused)
                        .filter_map(|(namespace, _)| namespace.as_ref())
                        .map(|namespace| format!("{kind}/{namespace}")),
                );
                narrowed |= !wide;
            } else {
                cover.unwatched.push(kind.to_string());
            }
            // The meta source reads every kind it is let: naming them all on
            // each of its spans would say nothing the followed ones need.
            if source == Source::Followed && kind != EVENT {
                cover.kinds.push(kind.to_string());
            }
        }
        cover.unwatched_in = refused_in.into_iter().collect();
        // A kind read only in the window's namespaces makes the whole span
        // speak for those alone: saying less is the honest side.
        if narrowed {
            cover.scope.clone_from(&self.scope);
        }
        Some(cover)
    }

    /// One of the cluster's events, new or repeated.
    pub fn event(&self, event: &k8s_openapi::api::core::v1::Event) {
        self.timeline.event(
            EventInfo::from(event),
            chrono::Utc::now().timestamp_millis(),
        );
    }

    /// Still watching: the open spans are stamped alive.
    pub fn heartbeat(&self) {
        self.timeline.spans(super::spans::SpanSets::heartbeat);
    }

    /// The watches stopped: every span ends now.
    pub fn stop(&mut self) {
        self.slots.clear();
        self.timeline.spans(|spans, now| {
            spans.end(Source::Followed, now);
            spans.end(Source::Meta, now);
        });
    }
}
