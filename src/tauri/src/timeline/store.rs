//! The rows of one cluster's timeline in memory: changes, warning series and
//! normal series, each bounded on its own so the start-up noise of a busy
//! cluster's pods never pushes a warning out, and each saying what it let go.

use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;

use super::{Cursor, LetGo, LetGoes, RowSays, TimelineQuery, TimelineRow, KEEP_FOR_MS};

/// Rows of each class kept in memory per cluster; the oldest go first.
pub(super) const MAX_CHANGES: usize = 20_000;
pub(super) const MAX_WARNINGS: usize = 10_000;
pub(super) const MAX_NORMAL: usize = 10_000;

/// One answer stays well under the 256 KiB an IPC message is held to.
pub(super) const PAGE_ROWS: usize = 500;
pub(super) const PAGE_BYTES: usize = 192 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Class {
    Changes,
    Warnings,
    Normal,
}

impl Class {
    pub(super) fn of(says: &RowSays) -> Self {
        match says {
            RowSays::Event { event } if event.type_ == "Warning" => Self::Warnings,
            RowSays::Event { .. } => Self::Normal,
            _ => Self::Changes,
        }
    }

    const fn cap(self) -> usize {
        match self {
            Self::Changes => MAX_CHANGES,
            Self::Warnings => MAX_WARNINGS,
            Self::Normal => MAX_NORMAL,
        }
    }
}

/// Which rows a surface draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Show {
    All,
    /// What changed on objects, no events.
    Changes,
    /// The cluster's Warning events only.
    Warnings,
}

impl Show {
    fn classes(self) -> &'static [Class] {
        match self {
            Self::All => &[Class::Changes, Class::Warnings, Class::Normal],
            Self::Changes => &[Class::Changes],
            Self::Warnings => &[Class::Warnings],
        }
    }
}

/// One object a timeline is about: its changes and the events about it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub kind: String,
    /// `None` matches the kind in any group.
    pub group: Option<String>,
    pub namespace: Option<String>,
    pub name: String,
}

type Key = (i64, u64);

struct Held {
    row: TimelineRow,
    bytes: usize,
}

#[derive(Default)]
pub(super) struct Store {
    rows: HashMap<Class, BTreeMap<Key, Held>>,
    /// Where each series' row is, by its id.
    series: HashMap<String, (Class, Key)>,
    by_seq: BTreeMap<u64, (Class, Key)>,
    seq: u64,
    let_go: HashMap<Class, LetGo>,
}

/// The API group an event's `apiVersion` names: `apps/v1` is `apps`, `v1` the core group.
pub(super) fn group_of(api_version: Option<&str>) -> String {
    api_version
        .and_then(|version| version.split_once('/'))
        .map(|(group, _)| group.to_string())
        .unwrap_or_default()
}

impl Store {
    pub(super) fn newest(&self) -> u64 {
        self.seq
    }

    pub(super) fn let_go(&self) -> LetGoes {
        let of = |class| self.let_go.get(&class).copied();
        LetGoes {
            changes: of(Class::Changes),
            warnings: of(Class::Warnings),
            normal: of(Class::Normal),
        }
    }

    /// Numbers a row and keeps it: a series' repeat replaces its row. Costs
    /// the row, not a pass over what is kept.
    pub(super) fn record(&mut self, mut row: TimelineRow, now: i64) -> TimelineRow {
        self.seq += 1;
        row.seq = self.seq;
        self.put(row.clone(), now);
        row
    }

    fn put(&mut self, row: TimelineRow, now: i64) {
        let class = Class::of(&row.what);
        let event = matches!(row.what, RowSays::Event { .. });
        if event {
            if let Some((was, key)) = self.series.remove(&row.id) {
                if let Some(held) = self.map(was).remove(&key) {
                    self.by_seq.remove(&held.row.seq);
                }
            }
        }
        let key = (row.at, row.seq);
        if event {
            self.series.insert(row.id.clone(), (class, key));
        }
        self.by_seq.insert(row.seq, (class, key));
        let bytes = serde_json::to_vec(&row).map_or(0, |line| line.len());
        self.map(class).insert(key, Held { row, bytes });
        self.bound(class, now);
    }

    fn map(&mut self, class: Class) -> &mut BTreeMap<Key, Held> {
        self.rows.entry(class).or_default()
    }

    /// Past the count the oldest rows are let go, and said to be; past the
    /// age they are outside every window and simply go.
    fn bound(&mut self, class: Class, now: i64) {
        loop {
            let map = self.map(class);
            let over = map.len() > class.cap();
            let Some((&key, _)) = map.first_key_value() else {
                return;
            };
            let old = key.0 < now - KEEP_FOR_MS;
            if !over && !old {
                return;
            }
            let held = self
                .map(class)
                .remove(&key)
                .expect("the first row is there");
            self.by_seq.remove(&held.row.seq);
            if matches!(held.row.what, RowSays::Event { .. }) {
                self.series.remove(&held.row.id);
            }
            if over && !old {
                let said = self.let_go.entry(class).or_default();
                said.before = said.before.max(key.0);
                said.cleared = false;
            }
        }
    }

    /// What was read back from disk, in the order it was written, numbered
    /// as it was then.
    pub(super) fn restore(&mut self, rows: Vec<TimelineRow>, let_go: LetGoes, now: i64) {
        for (class, said) in [
            (Class::Changes, let_go.changes),
            (Class::Warnings, let_go.warnings),
            (Class::Normal, let_go.normal),
        ] {
            if let Some(said) = said {
                self.let_go.insert(class, said);
            }
        }
        for row in rows {
            self.seq = self.seq.max(row.seq);
            self.put(row, now);
        }
    }

    /// Forgets every row and says they were cleared, now.
    pub(super) fn clear(&mut self, now: i64) {
        self.rows.clear();
        self.series.clear();
        self.by_seq.clear();
        for class in [Class::Changes, Class::Warnings, Class::Normal] {
            self.let_go.insert(
                class,
                LetGo {
                    before: now,
                    cleared: true,
                },
            );
        }
    }

    /// One page for `query`, newest first, and whether more remain past it.
    pub(super) fn page(&self, query: &TimelineQuery) -> (Vec<TimelineRow>, bool) {
        let classes = query.show.classes();
        let wanted = |class: Class, held: &Held| {
            classes.contains(&class) && held.row.at >= query.from && matches(&held.row, query)
        };
        let mut rows = Vec::new();
        let mut bytes = 0;
        let mut take = |held: &Held| {
            if rows.len() == PAGE_ROWS || bytes + held.bytes > PAGE_BYTES {
                return false;
            }
            bytes += held.bytes;
            rows.push(held.row.clone());
            true
        };
        if let Some(after) = query.after {
            let mut found: Vec<&Held> = self
                .by_seq
                .range(after + 1..)
                .filter_map(|(_, (class, key))| {
                    let held = self.rows.get(class)?.get(key)?;
                    wanted(*class, held).then_some(held)
                })
                .collect();
            found.sort_by_key(|held| std::cmp::Reverse((held.row.at, held.row.seq)));
            let more = found.into_iter().any(|held| !take(held));
            return (rows, more);
        }
        let below = query
            .before
            .map_or((i64::MAX, u64::MAX), |c: Cursor| (c.at, c.seq));
        let mut lanes: Vec<_> = classes
            .iter()
            .filter_map(|class| {
                let map = self.rows.get(class)?;
                Some(
                    map.range(..below)
                        .rev()
                        .filter(move |(_, held)| wanted(*class, held))
                        .peekable(),
                )
            })
            .collect();
        loop {
            let newest = lanes
                .iter_mut()
                .enumerate()
                .filter_map(|(at, lane)| lane.peek().map(|(key, _)| (**key, at)))
                .max();
            let Some((_, lane)) = newest else {
                return (rows, false);
            };
            let (_, held) = lanes[lane].next().expect("peeked");
            if !take(held) {
                return (rows, true);
            }
        }
    }
}

/// Whether a row is about the subject asked for, in the namespaces on screen.
fn matches(row: &TimelineRow, query: &TimelineQuery) -> bool {
    if let Some(subject) = &query.subject {
        if row.kind != subject.kind
            || subject
                .group
                .as_ref()
                .is_some_and(|group| *group != row.group)
            || row.namespace != subject.namespace
            || row.name != subject.name
        {
            return false;
        }
    }
    match (&query.scope, &row.namespace) {
        (None, _) => true,
        (Some(scope), _) if scope.is_empty() => true,
        (Some(scope), Some(namespace)) => scope.contains(namespace),
        // A Node or a cordon is every namespace's; a Namespace is its own.
        (Some(scope), None) => row.kind != "Namespace" || scope.contains(&row.name),
    }
}
