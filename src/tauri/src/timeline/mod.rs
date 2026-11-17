//! What this app saw happen on a cluster, on one clock: each change to an
//! object it followed, in the object's own field paths, and each series of
//! the cluster's events, beside the stretches it was and was not watching.
//!
//! Kept per cluster in memory and, unless the reader turned it off, on disk
//! (`disk`), each bounded by age and by size, and a row let go at a bound is
//! said to have been let go: the stretch it leaves is never drawn quiet.
//!
//! Nothing a change row says can be a value the app does not show: an env
//! literal, every `ConfigMap` or `Secret` value and every annotation that may
//! copy them are compared by a digest that never leaves this process (`project`).

mod disk;
pub(crate) mod follow;
pub mod project;
pub mod recorder;
mod spans;
mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use dashmap::DashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::resources::EventInfo;
use crate::state::AppEvent;

pub use spans::{Cover, ObservedSpan, Source, SpanSets};
use store::Store;
pub use store::{Show, TimelineSubject};

/// How long anything is kept: the widest window the page draws.
pub const KEEP_FOR_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// How often what was recorded is written and the window told of it.
const FLUSH_EVERY: Duration = Duration::from_secs(1);

/// One row of the timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRow {
    /// A change's own number, or an event's uid: a series is one row.
    pub id: String,
    /// The order rows were recorded in on this cluster. A series takes a new
    /// one each time it repeats.
    pub seq: u64,
    /// Milliseconds since the epoch: when the change was seen, or the
    /// series' last occurrence.
    pub at: i64,
    pub kind: String,
    pub group: String,
    pub namespace: Option<String>,
    pub name: String,
    pub what: RowSays,
    /// Found by comparing a list with what was seen before a break, not
    /// watched happening: `at` is when it was noticed.
    #[serde(default)]
    pub at_relist: bool,
}

/// What one row says happened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum RowSays {
    Created,
    Deleted,
    /// A followed object changed in these fields. `more` were left out of a
    /// row past its size; `before` names the revision that was current
    /// before a change to the template, where the object names one.
    Changed {
        fields: Vec<FieldMove>,
        more: usize,
        before: Option<String>,
    },
    /// Seen by name only: the generation moved, and what changed was not seen.
    Generation {
        from: Option<i64>,
        to: Option<i64>,
    },
    /// One of the cluster's events, as the Events page reads it.
    Event {
        event: Box<EventInfo>,
    },
}

/// One field of a change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum FieldMove {
    /// A kept value before and after; `None` where the field was absent.
    Moved {
        path: String,
        from: Option<String>,
        to: Option<String>,
    },
    /// A value the timeline does not keep, an env literal, a `ConfigMap` or
    /// `Secret` value, or an annotation that may copy one: only whether it
    /// was there, and that it changed.
    NotKept { path: String, was: bool, is: bool },
}

/// Where the rows of one class stop: older ones were let go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LetGo {
    /// The newest moment among the rows let go.
    pub before: i64,
    /// The reader cleared them in Settings, rather than a bound.
    #[serde(default)]
    pub cleared: bool,
}

/// What each class of row has let go of, `None` where nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LetGoes {
    pub changes: Option<LetGo>,
    pub warnings: Option<LetGo>,
    pub normal: Option<LetGo>,
}

/// Whether this cluster's timeline is kept between restarts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Keeping {
    Kept,
    /// Turned off in Settings: what is here lasts until the app closes.
    Off,
    /// On, and this machine has no data folder to keep it in: what is here
    /// lasts until the app closes.
    Nowhere,
    /// The disk refused: what is here lasts until the app closes.
    Failed {
        message: String,
    },
}

/// What keeping amounts to for a timeline kept in `dir`.
fn keeping_of(keep: bool, dir: Option<&PathBuf>) -> Keeping {
    match (keep, dir) {
        (false, _) => Keeping::Off,
        (true, None) => Keeping::Nowhere,
        (true, Some(_)) => Keeping::Kept,
    }
}

/// Whether the rows kept from an earlier run are this cluster's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Identity {
    /// Nothing was kept from an earlier run, or the cluster was checked to
    /// be the one it was kept for.
    Known,
    /// Kept from an earlier run, and not checked yet.
    NotChecked,
    /// Kept from an earlier run, and `kube-system` could not be read: the
    /// rows may be another cluster's that had this name.
    Unknown { message: String },
}

/// The question a timeline surface asks.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineQuery {
    pub context: String,
    pub subject: Option<TimelineSubject>,
    /// The namespaces on screen, `None` for all of them.
    pub scope: Option<Vec<String>>,
    pub from: i64,
    pub show: Show,
    /// Only rows recorded after this `seq`, newest first.
    pub after: Option<u64>,
    /// The page below this row, by its `at` and `seq`.
    pub before: Option<Cursor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub at: i64,
    pub seq: u64,
}

/// One page of the timeline, newest first, and everything needed to say
/// what the page cannot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePage {
    pub rows: Vec<TimelineRow>,
    /// Rows past this page remain: older ones for a page read `before`,
    /// newer ones for a page read `after`, which is then read again whole.
    pub more: bool,
    /// The newest `seq` this cluster has recorded.
    pub newest: u64,
    pub spans: SpanSets,
    pub let_go: LetGoes,
    pub keeping: Keeping,
    /// Lines of the kept files that could not be read and were skipped.
    pub unreadable: usize,
    /// Moves each time the rows start over, for another cluster under the
    /// name or a clear: a reader holding another's rows reads the first page
    /// again, since `newest` numbers from the start once more.
    pub epoch: u64,
    pub identity: Identity,
}

/// What is kept on this machine, for Settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub keep: bool,
    pub bytes: u64,
    pub clusters: usize,
}

pub struct ClusterTimeline {
    context: String,
    dir: Option<PathBuf>,
    inner: Mutex<Inner>,
}

struct Inner {
    store: Store,
    spans: SpanSets,
    pending: disk::Pending,
    keeping: Keeping,
    unreadable: usize,
    /// The cluster this name was last seen to be, by its `kube-system` uid.
    identity: Option<String>,
    /// Whether what was read back from disk is this cluster's.
    checked: Identity,
    epoch: u64,
    /// What the files' own bounds let go, kept apart from what memory did.
    disk_let_go: LetGoes,
    /// When rows were last taken to be written.
    flushed_at: i64,
    /// The stretches whose rows were dropped unwritten, keeping being off or
    /// the disk refusing: spans written later leave them out, or a restart
    /// would draw them watched and quiet.
    unkept: Vec<(i64, i64)>,
    /// Something to tell the window and to write since the last flush.
    told: Told,
}

/// What one flush took of a cluster to write.
struct Taken {
    pending: disk::Pending,
    told: Told,
    state: disk::State,
    since: i64,
    now: i64,
    epoch: u64,
}

#[derive(Default)]
struct Told {
    rows: bool,
    spans: bool,
}

impl ClusterTimeline {
    fn now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    /// A change to an object, numbered and kept.
    pub fn change(&self, row: TimelineRow) {
        let mut inner = self.inner.lock();
        let row = inner.store.record(row, Self::now());
        inner.pending.rows.push(row);
        inner.told.rows = true;
    }

    /// One of the cluster's events: a repeat replaces its series' row, and
    /// one handed over again as it is held, by a list or a renewal, is not
    /// recorded again.
    pub fn event(&self, event: EventInfo, seen: i64) {
        let at = [event.last_timestamp, event.first_timestamp]
            .into_iter()
            .flatten()
            .map(|moment| moment.timestamp_millis())
            .next()
            .unwrap_or(seen);
        let row = TimelineRow {
            id: event.uid.clone(),
            seq: 0,
            at,
            kind: event.involved_object.kind.clone(),
            group: store::group_of(event.involved_object.api_version.as_deref()),
            namespace: event.involved_object.namespace.clone(),
            name: event.involved_object.name.clone(),
            what: RowSays::Event {
                event: Box::new(event),
            },
            at_relist: false,
        };
        if self.inner.lock().store.holds(&row) {
            return;
        }
        self.change(row);
    }

    /// The spans this cluster's sources were watched over, changed in place.
    pub fn spans<T>(&self, change: impl FnOnce(&mut SpanSets, i64) -> T) -> T {
        let mut inner = self.inner.lock();
        let said = change(&mut inner.spans, Self::now());
        inner.told.spans = true;
        said
    }

    /// Told which cluster this name turned out to be. Another one drops what
    /// was kept under the name, and says so.
    pub fn seen_cluster(&self, identity: String) -> bool {
        let mut inner = self.inner.lock();
        let another = inner
            .identity
            .as_ref()
            .is_some_and(|known| *known != identity);
        if another {
            inner.store = Store::default();
            inner.spans = SpanSets::default();
            inner.disk_let_go = LetGoes::default();
            inner.pending = disk::Pending {
                wipe: true,
                ..disk::Pending::default()
            };
            inner.epoch += 1;
            inner.told.rows = true;
        }
        if inner.identity.as_deref() != Some(&identity) || inner.checked != Identity::Known {
            inner.identity = Some(identity);
            inner.checked = Identity::Known;
            inner.told.spans = true;
        }
        another
    }

    /// Which cluster this name is could not be read: nothing is dropped, and
    /// what was kept from an earlier run is said to be perhaps another's.
    pub fn not_identified(&self, message: String) {
        let mut inner = self.inner.lock();
        if inner.checked != Identity::Known {
            inner.checked = Identity::Unknown { message };
            inner.told.spans = true;
        }
    }

    /// The client behind the name was replaced, perhaps by another
    /// cluster's: whether what is held is this cluster's is checked again.
    /// Nothing is dropped; the next check decides.
    fn unchecked(&self) {
        let mut inner = self.inner.lock();
        let held = inner.store.newest() > 0
            || !inner.spans.followed.is_empty()
            || !inner.spans.meta.is_empty();
        if held && inner.checked == Identity::Known {
            inner.checked = Identity::NotChecked;
        }
    }

    /// One page of what was recorded.
    #[must_use]
    pub fn page(&self, query: &TimelineQuery) -> TimelinePage {
        let inner = self.inner.lock();
        let (rows, more) = inner.store.page(query);
        TimelinePage {
            rows,
            more,
            newest: inner.store.newest(),
            spans: inner.spans.clone(),
            let_go: inner.store.let_go(),
            keeping: inner.keeping.clone(),
            unreadable: inner.unreadable,
            epoch: inner.epoch,
            identity: inner.checked.clone(),
        }
    }

    /// Everything recorded is forgotten, here and on disk, and said to
    /// have been cleared.
    fn clear(&self) {
        let mut inner = self.inner.lock();
        inner.store.clear(Self::now());
        inner.epoch += 1;
        inner.disk_let_go = LetGoes::default();
        inner.pending = disk::Pending {
            wipe: true,
            ..disk::Pending::default()
        };
        inner.told = Told {
            rows: true,
            spans: true,
        };
    }
}

/// Every cluster's timeline, and the task that writes them.
pub struct Timelines {
    root: Option<PathBuf>,
    keep: AtomicBool,
    clusters: DashMap<String, Arc<ClusterTimeline>>,
    events: broadcast::Sender<AppEvent>,
    writer: OnceLock<()>,
    /// The one context being recorded: the cluster on screen.
    following: Mutex<Option<follow::Follower>>,
    /// One keeping switch at a time, saved and then applied.
    keeping_turn: tokio::sync::Mutex<()>,
    /// One writer of the files at a time: a flush, or a clear.
    io: Mutex<()>,
}

impl Timelines {
    /// `root` is where timelines are kept; `None` keeps nothing on disk.
    #[must_use]
    pub fn new(root: Option<PathBuf>, keep: bool, events: broadcast::Sender<AppEvent>) -> Self {
        Self {
            root,
            keep: AtomicBool::new(keep),
            clusters: DashMap::new(),
            events,
            writer: OnceLock::new(),
            following: Mutex::new(None),
            keeping_turn: tokio::sync::Mutex::new(()),
            io: Mutex::new(()),
        }
    }

    /// Records `context` from what `subscription` hands over, in place of
    /// whatever was recorded before.
    pub(crate) fn follow(&self, context: String, subscription: crate::feeds::Subscription) {
        let cluster = self.cluster(&context);
        *self.following.lock() = Some(follow::spawn(context, cluster, subscription));
    }

    /// Tells the follower of `context`, where it is the one recording.
    /// `false` where none is.
    pub(crate) fn tell(&self, context: &str, control: follow::Control) -> bool {
        let following = self.following.lock();
        following
            .as_ref()
            .filter(|follower| follower.context == context)
            .is_some_and(|follower| follower.control.send(control).is_ok())
    }

    /// Where this machine keeps timelines, beside nothing else.
    #[must_use]
    pub fn default_root() -> Option<PathBuf> {
        dirs::data_local_dir().map(|dir| dir.join("k8s-gui").join("timeline"))
    }

    #[must_use]
    pub fn keeps(&self) -> bool {
        self.keep.load(Ordering::Relaxed)
    }

    /// Keeping between restarts on or off. Off writes nothing more and
    /// deletes nothing: what is kept stays until it is cleared.
    pub fn set_keep(&self, keep: bool) {
        self.keep.store(keep, Ordering::Relaxed);
        for cluster in &self.clusters {
            let mut inner = cluster.inner.lock();
            inner.keeping = keeping_of(keep, cluster.dir.as_ref());
            inner.told.spans = true;
        }
    }

    /// A context's client was replaced by a connect or a disconnect, not a
    /// renewal: the cluster behind the name may be another one now.
    pub fn client_replaced(&self, context: &str) {
        if let Some(cluster) = self.clusters.get(context) {
            cluster.unchecked();
        }
    }

    /// Keeping saved by `save` and then set here, as one step: two switches
    /// that meet are applied in the order they were saved, and the file and
    /// the app never disagree about whether the timeline is kept.
    ///
    /// # Errors
    ///
    /// What `save` failed with; keeping is then left as it was.
    pub async fn keep_saved<E>(
        &self,
        keep: bool,
        save: impl std::future::Future<Output = Result<(), E>>,
    ) -> Result<(), E> {
        let _turn = self.keeping_turn.lock().await;
        save.await?;
        self.set_keep(keep);
        Ok(())
    }

    /// A context's timeline, read back from disk the first time it is asked
    /// for. Blocks on the disk: call it off the window's thread.
    pub fn cluster(&self, context: &str) -> Arc<ClusterTimeline> {
        if let Some(held) = self.clusters.get(context) {
            return held.clone();
        }
        let dir = self.root.as_ref().map(|root| disk::dir_of(root, context));
        let now = ClusterTimeline::now();
        let loaded = dir
            .as_deref()
            .map(|dir| disk::load(dir, now))
            .unwrap_or_default();
        let kept = !loaded.rows.is_empty()
            || !loaded.spans.followed.is_empty()
            || !loaded.spans.meta.is_empty();
        let mut store = Store::default();
        store.restore(loaded.rows, loaded.let_go, now);
        let disk_let_go = loaded.let_go;
        let mut spans = loaded.spans;
        spans.closed();
        spans.prune(now);
        let keeping = keeping_of(self.keeps(), dir.as_ref());
        let cluster = Arc::new(ClusterTimeline {
            context: context.to_string(),
            dir,
            inner: Mutex::new(Inner {
                store,
                spans,
                pending: disk::Pending::default(),
                keeping,
                unreadable: loaded.unreadable,
                identity: loaded.identity,
                checked: if kept {
                    Identity::NotChecked
                } else {
                    Identity::Known
                },
                epoch: 0,
                disk_let_go,
                flushed_at: now,
                unkept: Vec::new(),
                told: Told::default(),
            }),
        });
        self.clusters
            .entry(context.to_string())
            .or_insert(cluster)
            .clone()
    }

    /// The writer, started from the first caller inside the runtime.
    pub fn start_writer(self: &Arc<Self>) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let mut started = false;
        self.writer.get_or_init(|| started = true);
        if !started {
            return;
        }
        let timelines = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(FLUSH_EVERY);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let Some(timelines) = timelines.upgrade() else {
                    break;
                };
                let _ = tokio::task::spawn_blocking(move || timelines.flush()).await;
            }
        });
    }

    /// Writes what each cluster recorded since the last flush and tells the
    /// window, at most once per flush per cluster.
    pub fn flush(&self) {
        let keep = self.keeps();
        let clusters: Vec<Arc<ClusterTimeline>> =
            self.clusters.iter().map(|held| held.clone()).collect();
        for cluster in clusters {
            let _io = self.io.lock();
            let taken = Self::take(&cluster, keep);
            self.write(&cluster, keep, taken);
        }
    }

    /// What a cluster recorded since the last flush, taken to be written.
    fn take(cluster: &ClusterTimeline, keep: bool) -> Taken {
        let now = ClusterTimeline::now();
        let mut inner = cluster.inner.lock();
        let told = std::mem::take(&mut inner.told);
        let pending = std::mem::take(&mut inner.pending);
        let since = std::mem::replace(&mut inner.flushed_at, now);
        if !keep && cluster.dir.is_some() && !pending.rows.is_empty() {
            inner.unkept.push((since, now));
        }
        inner.unkept.retain(|(_, to)| now - to < KEEP_FOR_MS);
        let state = disk::State {
            context: cluster.context.clone(),
            identity: inner.identity.clone(),
            spans: inner.spans.without(&inner.unkept),
            let_go: disk::merged(inner.store.let_go(), inner.disk_let_go),
        };
        Taken {
            pending,
            told,
            state,
            since,
            now,
            epoch: inner.epoch,
        }
    }

    /// Writes what was taken, unless the rows started over since: a clear or
    /// another cluster under the name between the two put back on disk what
    /// was just let go of.
    fn write(&self, cluster: &ClusterTimeline, keep: bool, taken: Taken) {
        let Taken {
            pending,
            told,
            state,
            since,
            now,
            epoch,
        } = taken;
        // A cluster with nothing new since is not written again: an idle
        // one was a full fsync a second, and a context merely read was a
        // folder in Settings.
        let changed = told.rows || told.spans;
        let current = cluster.inner.lock().epoch == epoch;
        if let (Some(dir), true) = (&cluster.dir, current && ((keep && changed) || pending.wipe)) {
            let written = disk::write(dir, &pending, keep.then_some(&state), now);
            let mut inner = cluster.inner.lock();
            let next = match written {
                Ok(let_go) => {
                    inner.disk_let_go = disk::merged(inner.disk_let_go, let_go);
                    keeping_of(keep, Some(dir))
                }
                Err(error) => {
                    // A wipe not done is done next time: written over, the old
                    // cluster's rows would read back as this one's.
                    if pending.wipe {
                        inner.pending.wipe = true;
                    }
                    if !pending.rows.is_empty() {
                        inner.unkept.push((since, now));
                        inner.told.spans = true;
                    }
                    Keeping::Failed {
                        message: error.to_string(),
                    }
                }
            };
            if inner.keeping != next {
                inner.keeping = next;
                let _ = self.events.send(AppEvent::TimelineChanged {
                    context: cluster.context.clone(),
                    rows: false,
                    spans: true,
                });
            }
        }
        if told.rows || told.spans {
            let _ = self.events.send(AppEvent::TimelineChanged {
                context: cluster.context.clone(),
                rows: told.rows,
                spans: told.spans,
            });
        }
    }

    /// What is kept on disk, for Settings. Blocks on the disk.
    #[must_use]
    pub fn kept(&self) -> Kept {
        let (bytes, clusters) = self.root.as_deref().map_or((0, 0), disk::measure);
        Kept {
            keep: self.keeps(),
            bytes,
            clusters,
        }
    }

    /// Forgets every cluster's timeline, in memory and on disk. Blocks on
    /// the disk.
    ///
    /// # Errors
    ///
    /// The kept files could not be removed.
    pub fn clear(&self) -> std::io::Result<()> {
        let _io = self.io.lock();
        for cluster in &self.clusters {
            cluster.clear();
        }
        if let Some(root) = &self.root {
            disk::clear(root)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
