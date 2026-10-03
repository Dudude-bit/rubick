//! One stream over several namespaces' watches.
//!
//! Each namespace has its own watcher: a cluster-wide one needs rights a
//! namespace-scoped token lacks. The frontend keeps one list for all of them
//! and swaps it wholesale on `synced`, so a namespace that re-lists on its own
//! must not end its burst with `synced` — the swap would drop every other
//! namespace's rows. Here the stream keeps what each namespace last said, and
//! a re-list anywhere is one `restarted`, every namespace's rows, and one
//! `synced` once no namespace is still re-listing.
//!
//! A namespace failing fails the stream, by name. Nothing is said while it
//! fails — the page is polling, and any change sent would read as recovery —
//! and when it answers again the page is told everything again.

use std::collections::BTreeMap;
use std::fmt::Display;

use kube::runtime::watcher::Event;
use kube::ResourceExt;
use serde::Serialize;

use super::failure::{answered, FailureLatch};
use crate::state::{RawJson, WatchOp};

/// What the stream sends, in order.
#[derive(Debug)]
pub(super) enum Out {
    Change(WatchOp, RawJson),
    Marker(WatchOp),
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Steady,
    Syncing,
    Failed,
}

struct Member {
    namespace: String,
    /// What the page holds for this namespace, by name, as last sent.
    rows: BTreeMap<String, RawJson>,
    relisting: bool,
    listed: bool,
    failing: bool,
    latch: FailureLatch,
}

/// The shared resync barrier over one stream's namespaces.
pub(super) struct ScopeSync {
    members: Vec<Member>,
    mode: Mode,
}

impl ScopeSync {
    pub(super) fn new(namespaces: Vec<String>) -> Self {
        Self {
            members: namespaces
                .into_iter()
                .map(|namespace| Member {
                    namespace,
                    rows: BTreeMap::new(),
                    relisting: false,
                    listed: false,
                    failing: false,
                    latch: FailureLatch::new(),
                })
                .collect(),
            mode: Mode::Steady,
        }
    }

    pub(super) fn namespace(&self, at: usize) -> &str {
        &self.members[at].namespace
    }

    pub(super) fn streak(&self, at: usize) -> u32 {
        self.members[at].latch.consecutive_errors()
    }

    /// Fold one namespace's watcher event into what the stream says.
    pub(super) fn on<K, E, F, U>(
        &mut self,
        at: usize,
        event: Result<Event<K>, E>,
        transform: &F,
        out: &mut Vec<Out>,
    ) where
        K: kube::Resource,
        E: Display,
        F: Fn(&K) -> Option<U>,
        U: Serialize,
    {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                let member = &mut self.members[at];
                if member.latch.record_error() {
                    member.failing = true;
                    if self.mode != Mode::Failed {
                        self.mode = Mode::Failed;
                        out.push(Out::Failed(format!("{}: {error}", member.namespace)));
                    }
                }
                return;
            }
        };
        let speaking = self.mode != Mode::Failed;
        let member = &mut self.members[at];
        member.latch.saw(&event);
        if answered(&event) {
            member.failing = false;
        }
        match event {
            Event::Init => {
                let staged = std::mem::take(&mut member.rows);
                member.relisting = true;
                match self.mode {
                    Mode::Steady => {
                        self.restart(Some(at), out);
                        self.mode = Mode::Syncing;
                    }
                    // Its rows are in what the page is staging; they go, and
                    // the re-list brings back whichever still exist.
                    Mode::Syncing => out.extend(
                        staged
                            .into_values()
                            .map(|raw| Out::Change(WatchOp::Deleted, raw)),
                    ),
                    Mode::Failed => {}
                }
            }
            Event::InitApply(obj) | Event::Apply(obj) => {
                if let Some(raw) = serialised(&obj, transform) {
                    member.rows.insert(obj.name_any(), raw.clone());
                    if speaking {
                        out.push(Out::Change(WatchOp::Applied, raw));
                    }
                }
            }
            Event::Delete(obj) => {
                if let Some(raw) = serialised(&obj, transform) {
                    member.rows.remove(&obj.name_any());
                    if speaking {
                        out.push(Out::Change(WatchOp::Deleted, raw));
                    }
                }
            }
            Event::InitDone => {
                member.relisting = false;
                member.listed = true;
            }
        }
        if self.mode == Mode::Failed && !self.members.iter().any(|m| m.failing) {
            // The page polled while this failed, so its rows are nobody's
            // record of anything: every namespace goes out again.
            self.restart(None, out);
            self.mode = Mode::Syncing;
        }
        if self.mode == Mode::Syncing && self.members.iter().all(|m| m.listed && !m.relisting) {
            out.push(Out::Marker(WatchOp::Synced));
            self.mode = Mode::Steady;
        }
    }

    /// Open a resync the page stages, with every namespace's rows but those
    /// of `except`, which is about to re-list them itself.
    fn restart(&self, except: Option<usize>, out: &mut Vec<Out>) {
        out.push(Out::Marker(WatchOp::Restarted));
        for (at, member) in self.members.iter().enumerate() {
            if Some(at) != except {
                out.extend(
                    member
                        .rows
                        .values()
                        .map(|raw| Out::Change(WatchOp::Applied, raw.clone())),
                );
            }
        }
    }
}

fn serialised<K, F, U>(obj: &K, transform: &F) -> Option<RawJson>
where
    F: Fn(&K) -> Option<U>,
    U: Serialize,
{
    transform(obj).and_then(|row| serde_json::value::to_raw_value(&row).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::ConfigMap;
    use std::collections::BTreeSet;

    const A: usize = 0;
    const B: usize = 1;

    fn named(name: &str) -> ConfigMap {
        ConfigMap {
            metadata: kube::core::ObjectMeta {
                name: Some(name.to_string()),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn row(raw: &RawJson) -> String {
        serde_json::from_str(raw.get()).expect("a name")
    }

    /// The frontend's side of the protocol, as `useResourceWatch` applies
    /// it: a resync is staged and swapped in whole on `synced`.
    #[derive(Default)]
    struct Page {
        rows: BTreeSet<String>,
        staged: Option<BTreeSet<String>>,
        failures: Vec<String>,
        said: Vec<String>,
    }

    impl Page {
        fn read(&mut self, out: Vec<Out>) {
            for item in out {
                match item {
                    Out::Marker(WatchOp::Restarted) => {
                        self.said.push("restarted".into());
                        self.staged = Some(BTreeSet::new());
                    }
                    Out::Marker(WatchOp::Synced) => {
                        self.said.push("synced".into());
                        if let Some(staged) = self.staged.take() {
                            self.rows = staged;
                        }
                    }
                    Out::Marker(op) => panic!("unexpected marker {op:?}"),
                    Out::Change(op, raw) => {
                        let name = row(&raw);
                        self.said.push(format!("{op:?} {name}"));
                        let into = self.staged.as_mut().unwrap_or(&mut self.rows);
                        if op == WatchOp::Deleted {
                            into.remove(&name);
                        } else {
                            into.insert(name);
                        }
                    }
                    Out::Failed(message) => {
                        self.staged = None;
                        self.failures.push(message);
                    }
                }
            }
        }

        fn shows(&self) -> Vec<&str> {
            self.rows.iter().map(String::as_str).collect()
        }
    }

    struct Stream {
        sync: ScopeSync,
        page: Page,
    }

    impl Stream {
        fn new() -> Self {
            Self {
                sync: ScopeSync::new(vec!["prod".into(), "staging".into()]),
                page: Page::default(),
            }
        }

        fn send(&mut self, at: usize, event: Event<ConfigMap>) -> &mut Self {
            let mut out = Vec::new();
            self.sync
                .on::<_, String, _, _>(at, Ok(event), &name_of, &mut out);
            self.page.read(out);
            self
        }

        fn refuse(&mut self, at: usize) -> &mut Self {
            let mut out = Vec::new();
            self.sync.on::<ConfigMap, _, _, _>(
                at,
                Err("configmaps is forbidden"),
                &name_of,
                &mut out,
            );
            self.page.read(out);
            self
        }

        /// Both namespaces listed once: `prod` holds `a`, `staging` holds `s`.
        fn synced() -> Self {
            let mut stream = Self::new();
            stream
                .send(A, Event::Init)
                .send(B, Event::Init)
                .send(A, Event::InitApply(named("a")))
                .send(A, Event::InitDone)
                .send(B, Event::InitApply(named("s")))
                .send(B, Event::InitDone);
            stream.page.said.clear();
            stream
        }
    }

    fn name_of(map: &ConfigMap) -> Option<String> {
        map.metadata.name.clone()
    }

    /// The barrier itself. Sending `synced` when `prod` finished listing
    /// would have the page swap in a list with none of `staging` in it.
    #[test]
    fn the_first_sync_waits_for_every_namespace() {
        let mut stream = Stream::new();
        stream
            .send(A, Event::Init)
            .send(B, Event::Init)
            .send(A, Event::InitApply(named("a")))
            .send(A, Event::InitDone);
        assert!(!stream.page.said.contains(&"synced".to_string()));
        assert!(stream.page.shows().is_empty(), "nothing swapped in yet");

        stream
            .send(B, Event::InitApply(named("s")))
            .send(B, Event::InitDone);
        assert_eq!(stream.page.shows(), ["a", "s"]);
        assert_eq!(
            stream.page.said.first().map(String::as_str),
            Some("restarted")
        );
        assert_eq!(stream.page.said.last().map(String::as_str), Some("synced"));
    }

    /// One namespace re-listing on its own — a 410 after a long disconnect —
    /// must not take the other's rows with it when the page swaps.
    #[test]
    fn a_namespace_relisting_alone_keeps_the_other_namespaces_rows() {
        let mut stream = Stream::synced();
        stream.send(B, Event::Init);
        assert_eq!(stream.page.said, ["restarted", "Applied a"]);

        stream
            .send(B, Event::InitApply(named("t")))
            .send(B, Event::InitDone);
        assert_eq!(stream.page.shows(), ["a", "t"], "s went away, a stayed");
    }

    /// A namespace that starts over in the middle of a resync had already
    /// put rows into what the page is staging; the ones gone since must not
    /// survive the swap.
    #[test]
    fn a_namespace_restarting_mid_resync_takes_back_what_it_staged() {
        let mut stream = Stream::synced();
        stream
            .send(A, Event::Init)
            .send(B, Event::Init)
            .send(B, Event::InitApply(named("gone")))
            .send(B, Event::Init)
            .send(B, Event::InitApply(named("s")))
            .send(B, Event::InitDone)
            .send(A, Event::InitApply(named("a")))
            .send(A, Event::InitDone);
        assert_eq!(stream.page.shows(), ["a", "s"]);
    }

    /// Changes after the sync are the plain protocol, one namespace's at a
    /// time, with no marker around them.
    #[test]
    fn steady_changes_pass_straight_through() {
        let mut stream = Stream::synced();
        stream
            .send(A, Event::Apply(named("b")))
            .send(B, Event::Delete(named("s")));
        assert_eq!(stream.page.said, ["Applied b", "Deleted s"]);
        assert_eq!(stream.page.shows(), ["a", "b"]);
    }

    /// A refused namespace fails the stream by name, once, and never lets it
    /// say `synced` over rows it could not read.
    #[test]
    fn a_namespace_that_keeps_failing_fails_the_stream_by_name() {
        let mut stream = Stream::new();
        stream
            .send(A, Event::Init)
            .send(A, Event::InitApply(named("a")))
            .send(A, Event::InitDone);
        for _ in 0..5 {
            stream.send(B, Event::Init).refuse(B);
        }
        assert_eq!(stream.page.failures.len(), 1);
        assert!(stream.page.failures[0].starts_with("staging: "));
        assert!(!stream.page.said.contains(&"synced".to_string()));
    }

    /// While a namespace fails the page polls, and any change sent would
    /// read to it as recovery — the live badge back over a dead namespace.
    #[test]
    fn nothing_is_said_while_a_namespace_is_failing() {
        let mut stream = Stream::synced();
        stream.refuse(B).refuse(B).refuse(B);
        stream.page.said.clear();
        stream
            .send(A, Event::Apply(named("b")))
            .send(B, Event::Init);
        assert!(stream.page.said.is_empty(), "said {:?}", stream.page.said);
    }

    /// Recovery is a resync of everything, `prod` included: the page's rows
    /// came from polling while the stream was down, and a change `prod` made
    /// then was never sent.
    #[test]
    fn a_recovered_stream_resyncs_every_namespace() {
        let mut stream = Stream::synced();
        stream.refuse(B).refuse(B).refuse(B);
        stream
            .send(A, Event::Apply(named("b")))
            .send(B, Event::Init)
            .send(B, Event::InitApply(named("s")));
        assert_eq!(
            stream.page.said.first().map(String::as_str),
            Some("restarted")
        );
        assert!(!stream.page.said.contains(&"synced".to_string()));

        stream.send(B, Event::InitDone);
        assert_eq!(stream.page.shows(), ["a", "b", "s"]);
    }
}
