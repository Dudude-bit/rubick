//! What the watches saw, turned into rows and spans: one baseline per object
//! a followed kind holds, a row for each change after it, a row for each
//! object created or deleted, and a span while every watch is live or was
//! refused. A list after a break is compared with what was seen before it,
//! and what differs is said to have been noticed then, not seen happening.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use serde_json::Value;

use super::project::{changed, followed, snapshot, Followed, Snapshot};
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

/// How an object of a kind read by name only came to be seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sight {
    /// What was there when reading began.
    First,
    /// In a list after a break or a list turn: what differs moved unseen.
    Relist,
    Watched,
}

/// The kinds the followed spans speak for are these, not Event.
const EVENT: &str = "Event";

type Key = (Option<String>, String);

fn key_of(object: &Value) -> Option<Key> {
    let meta = object.get("metadata")?;
    let name = meta.get("name")?.as_str()?.to_string();
    let namespace = meta
        .get("namespace")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((namespace, name))
}

/// What one slot of a followed kind holds.
#[derive(Default)]
struct Objects {
    seen: HashMap<Key, Snapshot>,
    /// The creation time of what was deleted under each key, so a late
    /// report of it does not bring it back.
    gone: HashMap<Key, Option<String>>,
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
    objects: HashMap<(&'static str, &'static str, Option<String>), Objects>,
    named: HashMap<String, Named>,
    slots: BTreeMap<(Source, Slot), SlotState>,
    /// The window's namespaces, where a kind refused across the cluster is
    /// read instead.
    scope: Vec<String>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
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

    /// The window's namespaces changed.
    pub fn rescope(&mut self, scope: Vec<String>) {
        self.scope = scope;
    }

    fn row(followed: &Followed, key: &Key, what: RowSays) -> TimelineRow {
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
        row.at = now();
        row.at_relist = at_relist;
        self.timeline.change(row);
    }

    fn slot_objects(&mut self, followed: &'static Followed, slot: Option<&str>) -> &mut Objects {
        self.objects
            .entry((followed.kind, followed.group, slot.map(str::to_string)))
            .or_default()
    }

    /// A slot's whole list. The first is a baseline and says nothing; one
    /// after a break, a list turn or a lost update is compared with what
    /// was held, and what moved is said to have been noticed now.
    pub fn listed<'a>(
        &mut self,
        followed: &'static Followed,
        slot: Option<&str>,
        items: impl IntoIterator<Item = &'a Value>,
        first: bool,
    ) {
        let mut fresh = HashMap::new();
        for object in items {
            if let Some(key) = key_of(object) {
                fresh.insert(key, snapshot(followed, object));
            }
        }
        let objects = self.slot_objects(followed, slot);
        if first {
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
    pub fn applied(&mut self, followed: &'static Followed, slot: Option<&str>, object: &Value) {
        let Some(key) = key_of(object) else {
            return;
        };
        let next = snapshot(followed, object);
        let objects = self.slot_objects(followed, slot);
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
    pub fn deleted(&mut self, followed: &'static Followed, slot: Option<&str>, object: &Value) {
        let Some(key) = key_of(object) else {
            return;
        };
        let objects = self.slot_objects(followed, slot);
        let Some(prev) = objects.seen.remove(&key) else {
            return;
        };
        objects.gone.insert(key.clone(), prev.born);
        self.record(Self::row(followed, &key, RowSays::Deleted), false);
    }

    /// One of the cluster's events, new or repeated.
    pub fn event(&self, event: &k8s_openapi::api::core::v1::Event) {
        self.timeline.event(EventInfo::from(event), now());
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
    /// moved, or it is new. A followed kind is said whole by its own watch,
    /// and a controller's object's birth is its owner's story.
    pub fn named_seen(&mut self, item: &Named, sight: Sight) {
        if item.kind == EVENT || followed(&item.kind, &item.group).is_some() {
            return;
        }
        let before = self.named.insert(item.uid.clone(), item.clone());
        let what = match before {
            Some(prev) if prev.generation != item.generation && item.generation.is_some() => {
                prev.generation.map(|from| RowSays::Generation {
                    from: Some(from),
                    to: item.generation,
                })
            }
            None if sight != Sight::First && !item.controlled => Some(RowSays::Created),
            _ => None,
        };
        if let Some(what) = what {
            self.record(Self::named_row(item, what), sight == Sight::Relist);
        }
    }

    /// One object of a kind read by name only, deleted, or absent from a
    /// list after a break.
    pub fn named_gone(&mut self, uid: &str, relisted: bool) {
        if let Some(item) = self.named.remove(uid) {
            if !item.controlled {
                self.record(Self::named_row(&item, RowSays::Deleted), relisted);
            }
        }
    }

    /// How one watch stands now. A source's span is open while every one
    /// of its watches is live or refused and one is live; a change in what
    /// was refused ends it and starts the next, which says the new refusal.
    /// A watch gone blind ends it where it was last known to see, `since`.
    pub fn state(&mut self, source: Source, slot: Slot, state: SlotState, since: Option<i64>) {
        let was = self.cover(source);
        self.slots.insert((source, slot), state);
        self.settle(source, was.as_ref(), since);
    }

    /// How one watch stands, as last told.
    #[must_use]
    pub fn slot_state(&self, source: Source, slot: &Slot) -> Option<SlotState> {
        self.slots.get(&(source, slot.clone())).copied()
    }

    /// A kind the cluster does not serve holds nothing shut and is not
    /// named as refused: it is not one of the kinds.
    pub fn forget(&mut self, source: Source, kind: &str) {
        let was = self.cover(source);
        self.slots
            .retain(|(of, slot), _| !(*of == source && slot.kind == kind));
        self.settle(source, was.as_ref(), None);
    }

    fn settle(&mut self, source: Source, was: Option<&Cover>, since: Option<i64>) {
        let now = self.cover(source);
        if was == now.as_ref() {
            return;
        }
        self.timeline.spans(|spans, at| match now {
            None => spans.end(source, since.map_or(at, |since| since.min(at))),
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

    /// Still watching: the open spans are stamped alive.
    pub fn heartbeat(&self) {
        self.timeline.spans(super::spans::SpanSets::heartbeat);
    }

    /// The name-only reading ended: its span ends now, and what it held is
    /// a first sight when it is read again.
    pub fn meta_ended(&mut self) {
        self.slots.retain(|(source, _), _| *source != Source::Meta);
        self.named.clear();
        self.timeline
            .spans(|spans, now| spans.end(Source::Meta, now));
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
