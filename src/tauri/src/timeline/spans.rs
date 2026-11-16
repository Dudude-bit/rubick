//! The stretches this app was watching a cluster, by source: the followed
//! kinds, read whole, and the rest, read by name through the ownership
//! index. A stretch no span covers is "not observed", never "quiet".

use serde::{Deserialize, Serialize};

use super::KEEP_FOR_MS;

/// How often an open span is stamped alive.
pub const HEARTBEAT_MS: i64 = 30_000;

/// A heartbeat this late did not run: the machine was asleep, and nothing
/// was watched in between. Extending the span to now would draw those hours
/// as a quiet cluster.
pub const HEARTBEAT_MISSED_MS: i64 = 3 * HEARTBEAT_MS;

/// A stretch one source was watching. `to` is `None` while it still is.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedSpan {
    pub from: i64,
    /// The last moment it was known alive; a crash leaves this as the end.
    pub seen_at: i64,
    pub to: Option<i64>,
    /// Kinds refused, or not read, everywhere it asked.
    #[serde(default)]
    pub unwatched: Vec<String>,
    /// Kinds refused in some namespaces only, as `<kind>/<namespace>`.
    #[serde(default)]
    pub unwatched_in: Vec<String>,
    /// The namespaces it watched; empty for the whole cluster.
    #[serde(default)]
    pub scope: Vec<String>,
    /// The kinds it followed, so a quiet stretch names what it speaks for.
    #[serde(default)]
    pub kinds: Vec<String>,
}

/// What a span watched, and what it was not let see; see [`ObservedSpan`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Cover {
    pub unwatched: Vec<String>,
    pub unwatched_in: Vec<String>,
    pub scope: Vec<String>,
    pub kinds: Vec<String>,
}

impl ObservedSpan {
    fn starting(now: i64, cover: Cover) -> Self {
        Self {
            from: now,
            seen_at: now,
            to: None,
            unwatched: cover.unwatched,
            unwatched_in: cover.unwatched_in,
            scope: cover.scope,
            kinds: cover.kinds,
        }
    }

    fn cover(&self) -> Cover {
        Cover {
            unwatched: self.unwatched.clone(),
            unwatched_in: self.unwatched_in.clone(),
            scope: self.scope.clone(),
            kinds: self.kinds.clone(),
        }
    }

    /// Two spans watched alike where they list the same things in any order.
    fn same(&self, other: &Self) -> bool {
        let sorted = |list: &[String]| {
            let mut list = list.to_vec();
            list.sort();
            list
        };
        sorted(&self.unwatched) == sorted(&other.unwatched)
            && sorted(&self.unwatched_in) == sorted(&other.unwatched_in)
            && sorted(&self.scope) == sorted(&other.scope)
            && sorted(&self.kinds) == sorted(&other.kinds)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Source {
    /// The followed kinds, read whole.
    Followed,
    /// Every other kind, read by name through the ownership index.
    Meta,
}

/// Both sources' spans for one cluster.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanSets {
    pub followed: Vec<ObservedSpan>,
    pub meta: Vec<ObservedSpan>,
}

impl SpanSets {
    fn of(&mut self, source: Source) -> &mut Vec<ObservedSpan> {
        match source {
            Source::Followed => &mut self.followed,
            Source::Meta => &mut self.meta,
        }
    }

    /// The source is up and has its baseline, over what `cover` says. One
    /// still open ends where it was last seen alive.
    pub fn begin(&mut self, source: Source, now: i64, cover: Cover) {
        let list = self.of(source);
        for span in list.iter_mut() {
            if span.to.is_none() {
                span.to = Some(span.seen_at);
            }
        }
        *list = pruned(std::mem::take(list), now);
        list.push(ObservedSpan::starting(now, cover));
    }

    /// Still alive. A tick this late means the timer did not run: the
    /// stretch since the last one was not watched, so the span ends there
    /// and a new one starts now, leaving a gap between them.
    pub fn heartbeat(&mut self, now: i64) {
        for source in [Source::Followed, Source::Meta] {
            let list = self.of(source);
            let Some(open) = list.iter().position(|span| span.to.is_none()) else {
                continue;
            };
            if now - list[open].seen_at > HEARTBEAT_MISSED_MS {
                let span = &mut list[open];
                span.to = Some(span.seen_at);
                let cover = span.cover();
                list.push(ObservedSpan::starting(now, cover));
            } else {
                list[open].seen_at = now;
            }
        }
    }

    /// The source stopped watching now. One whose heartbeat is this late
    /// ends where it was last alive: whatever ended it first after a sleep,
    /// a broken watch or a renewal, the hours asleep were not watched.
    pub fn end(&mut self, source: Source, now: i64) {
        for span in self.of(source).iter_mut() {
            if span.to.is_none() {
                let at = if now - span.seen_at > HEARTBEAT_MISSED_MS {
                    span.seen_at
                } else {
                    now
                };
                span.seen_at = at;
                span.to = Some(at);
            }
        }
    }

    /// Whether the source is watching now.
    #[must_use]
    pub fn open(&self, source: Source) -> bool {
        let list = match source {
            Source::Followed => &self.followed,
            Source::Meta => &self.meta,
        };
        list.iter().any(|span| span.to.is_none())
    }

    /// Read back after the process that wrote them ended: whatever was open
    /// did not keep watching after it, so it ends where it was last alive.
    pub fn closed(&mut self) {
        for span in self.followed.iter_mut().chain(self.meta.iter_mut()) {
            if span.to.is_none() {
                span.to = Some(span.seen_at);
            }
        }
    }

    pub fn prune(&mut self, now: i64) {
        self.followed = pruned(std::mem::take(&mut self.followed), now);
        self.meta = pruned(std::mem::take(&mut self.meta), now);
    }
}

/// Overlapping and touching spans that watched alike folded together, and
/// the ones older than anything kept dropped.
fn pruned(mut spans: Vec<ObservedSpan>, now: i64) -> Vec<ObservedSpan> {
    spans.retain(|span| now - span.to.unwrap_or(span.seen_at) < KEEP_FOR_MS);
    spans.sort_by_key(|span| span.from);
    let mut out: Vec<ObservedSpan> = Vec::with_capacity(spans.len());
    for span in spans {
        if let Some(last) = out.last_mut() {
            if let Some(end) = last.to {
                if span.from <= end && last.same(&span) {
                    last.seen_at = last.seen_at.max(span.seen_at);
                    last.to = span.to.map(|to| to.max(end));
                    continue;
                }
            }
        }
        out.push(span);
    }
    out
}
