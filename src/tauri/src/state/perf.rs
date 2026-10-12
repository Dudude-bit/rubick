//! What the backend pushed over the IPC bridge while a recording ran.
//!
//! Counting bytes means serialising every event a second time, so nothing is
//! counted until the frontend asks for a recording, and the counters reset
//! when it does: a report is one run, not the process's whole life. One lock
//! rather than four atomics, so a snapshot never mixes two runs.

use parking_lot::Mutex;
use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

/// One IPC message, as `src/contracts/ipc-budget.json` states it.
pub const IPC_TARGET_BYTES: usize = 262_144;
pub const IPC_LIMIT_BYTES: usize = 1_048_576;

/// What `value` comes to as JSON, counted without keeping the bytes.
#[must_use]
pub fn wire_len<T: serde::Serialize>(value: &T) -> usize {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 += buf.len();
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    let _ = serde_json::to_writer(&mut count, value);
    count.0
}

/// `rows`, grouped so that each group serialises to at most `budget` bytes.
/// Order is kept; a single row over the budget travels alone rather than
/// being dropped. Every row is serialised once here to be measured, which
/// is the price of a message that is known to fit before it is sent.
#[must_use]
pub fn chunks_within<T: serde::Serialize>(rows: Vec<T>, budget: usize) -> Vec<Vec<T>> {
    let mut chunks = Vec::new();
    let mut chunk = Vec::new();
    let mut used = 0;
    for row in rows {
        let bytes = wire_len(&row) + 1;
        if !chunk.is_empty() && used + bytes > budget {
            chunks.push(std::mem::take(&mut chunk));
            used = 0;
        }
        chunk.push(row);
        used += bytes;
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

/// Most recent wall times kept per command for percentiles, as the frontend's recorder keeps.
const SAMPLE_CAP: usize = 5000;

#[derive(Default)]
struct Counters {
    recording: bool,
    events_emitted: u64,
    event_bytes: u64,
    max_event_bytes: u64,
    watch_changes: u64,
    commands: BTreeMap<&'static str, Times>,
}

#[derive(Default)]
struct Times {
    count: u64,
    max: u64,
    max_api_calls: usize,
    recent: VecDeque<u64>,
}

/// One command as the backend timed it, from its first poll to its answer.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandTimes {
    pub count: u64,
    pub p50: u64,
    pub p95: u64,
    pub max: u64,
    pub max_api_calls: usize,
}

#[derive(Default)]
pub struct PerfCounters {
    inner: Mutex<Counters>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSnapshot {
    pub recording: bool,
    pub events_emitted: u64,
    pub event_bytes: u64,
    pub max_event_bytes: u64,
    pub watch_changes: u64,
    pub commands: BTreeMap<String, CommandTimes>,
}

impl PerfCounters {
    pub fn set_recording(&self, on: bool) {
        let mut c = self.inner.lock();
        if on {
            *c = Counters::default();
        }
        c.recording = on;
    }

    pub fn is_recording(&self) -> bool {
        self.inner.lock().recording
    }

    /// One event went out: how many bytes its payload serialised to, and how
    /// many watch changes it carried (zero for anything but a watch batch).
    pub fn observe(&self, bytes: usize, watch_changes: usize) {
        let mut c = self.inner.lock();
        if !c.recording {
            return;
        }
        let bytes = bytes as u64;
        c.events_emitted += 1;
        c.event_bytes += bytes;
        c.max_event_bytes = c.max_event_bytes.max(bytes);
        c.watch_changes += watch_changes as u64;
    }

    pub fn snapshot(&self) -> PerfSnapshot {
        let c = self.inner.lock();
        PerfSnapshot {
            recording: c.recording,
            events_emitted: c.events_emitted,
            event_bytes: c.event_bytes,
            max_event_bytes: c.max_event_bytes,
            watch_changes: c.watch_changes,
            commands: c
                .commands
                .iter()
                .map(|(name, times)| ((*name).to_string(), times.summary()))
                .collect(),
        }
    }

    /// One timed command answered, `api_calls` requests made on its task.
    pub fn observe_command(&self, name: &'static str, took: Duration, api_calls: usize) {
        let mut c = self.inner.lock();
        if !c.recording {
            return;
        }
        let ms = u64::try_from(took.as_millis()).unwrap_or(u64::MAX);
        let times = c.commands.entry(name).or_default();
        times.count += 1;
        times.max = times.max.max(ms);
        times.max_api_calls = times.max_api_calls.max(api_calls);
        if times.recent.len() == SAMPLE_CAP {
            times.recent.pop_front();
        }
        times.recent.push_back(ms);
    }
}

impl Times {
    fn summary(&self) -> CommandTimes {
        let mut sorted: Vec<u64> = self.recent.iter().copied().collect();
        sorted.sort_unstable();
        CommandTimes {
            count: self.count,
            p50: percentile(&sorted, 50),
            p95: percentile(&sorted, 95),
            max: self.max,
            max_api_calls: self.max_api_calls,
        }
    }
}

/// Nearest rank over an ascending list, as `percentile` in `src/ui/lib/perf.ts` takes it.
fn percentile(sorted: &[u64], p: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (p * sorted.len()).div_ceil(100).clamp(1, sorted.len());
    sorted[rank - 1]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(n: usize) -> String {
        "x".repeat(n)
    }

    /// The budget is per message. A chunk over it is the 78 MiB message again, only smaller.
    #[test]
    fn every_chunk_fits_the_budget_and_no_row_is_lost_or_reordered() {
        let rows: Vec<String> = (1..=40).map(|i| row(i * 5)).collect();
        let chunks = chunks_within(rows.clone(), 300);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(serde_json::to_vec(chunk).unwrap().len() <= 300);
        }
        let back: Vec<String> = chunks.into_iter().flatten().collect();
        assert_eq!(back, rows);
    }

    /// One row larger than the budget is still a row. Dropping it would make a pod disappear from the list.
    #[test]
    fn a_row_over_budget_travels_alone() {
        let chunks = chunks_within(vec![row(10), row(500), row(10)], 100);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[1][0].len(), 500);
    }

    /// The same row arriving *first*, which is what the `!chunk.is_empty()`
    /// guard is for: without it an over-budget row opens by flushing a chunk
    /// that holds nothing, and the reader is handed an empty batch. The test
    /// above never reaches that branch — its big row always finds a chunk
    /// already open — so the guard could be deleted with the suite green.
    #[test]
    fn an_over_budget_row_at_the_front_yields_no_empty_chunk() {
        let chunks = chunks_within(vec![row(500), row(10)], 100);
        assert!(
            chunks.iter().all(|chunk| !chunk.is_empty()),
            "an empty batch is a message that says nothing: {chunks:?}"
        );
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0][0].len(), 500);
    }

    #[test]
    fn nothing_yields_no_chunks() {
        assert!(chunks_within(Vec::<String>::new(), 100).is_empty());
    }

    /// Counting while idle would make every event pay for a second serialisation.
    #[test]
    fn nothing_is_counted_until_a_recording_starts() {
        let c = PerfCounters::default();
        c.observe(100, 3);
        assert_eq!(c.snapshot().events_emitted, 0);
        c.set_recording(true);
        c.observe(100, 3);
        c.observe(40, 0);
        assert_eq!(
            c.snapshot(),
            PerfSnapshot {
                recording: true,
                events_emitted: 2,
                event_bytes: 140,
                max_event_bytes: 100,
                watch_changes: 3,
                commands: BTreeMap::new(),
            }
        );
    }

    /// A second run that kept the first run's numbers would report two runs as one.
    #[test]
    fn starting_a_recording_resets_the_previous_run() {
        let c = PerfCounters::default();
        c.set_recording(true);
        c.observe(5, 1);
        c.set_recording(false);
        assert_eq!(c.snapshot().events_emitted, 1);
        c.set_recording(true);
        assert_eq!(c.snapshot().events_emitted, 0);
        assert!(c.snapshot().recording);
    }

    /// Timing commands nobody records would take a lock on every call for
    /// numbers no one reads; a percentile taken another way than the
    /// frontend's would put two different p95s side by side in one report.
    #[test]
    fn a_command_is_timed_only_while_recording_and_reported_by_nearest_rank() {
        let c = PerfCounters::default();
        c.observe_command("x", Duration::from_millis(5), 1);
        assert!(c.snapshot().commands.is_empty());
        c.set_recording(true);
        for ms in [10u64, 20, 30, 40, 1000] {
            c.observe_command(
                "x",
                Duration::from_millis(ms),
                usize::try_from(ms / 10).unwrap(),
            );
        }
        assert_eq!(
            c.snapshot().commands["x"],
            CommandTimes {
                count: 5,
                p50: 30,
                p95: 1000,
                max: 1000,
                max_api_calls: 100,
            }
        );
    }

    /// The frontend reads the same file; a constant edited on one side only is the drift this catches.
    #[test]
    fn the_ipc_budget_matches_the_shared_file() {
        const BUDGET: &str = include_str!("../../../contracts/ipc-budget.json");
        let budget: serde_json::Value = serde_json::from_str(BUDGET).unwrap();
        assert_eq!(budget["targetMessageBytes"], IPC_TARGET_BYTES);
        assert_eq!(budget["maxMessageBytes"], IPC_LIMIT_BYTES);
    }
}
