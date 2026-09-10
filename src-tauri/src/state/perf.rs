//! What the backend pushed over the IPC bridge while a recording ran.
//!
//! Counting bytes means serialising every event a second time, so nothing is
//! counted until the frontend asks for a recording, and the counters reset
//! when it does: a report is one run, not the process's whole life. One lock
//! rather than four atomics, so a snapshot never mixes two runs.

use parking_lot::Mutex;

/// One IPC message, as `shared/ipc-budget.json` states it.
pub const IPC_TARGET_BYTES: usize = 262_144;
pub const IPC_LIMIT_BYTES: usize = 1_048_576;

#[derive(Default)]
struct Counters {
    recording: bool,
    events_emitted: u64,
    event_bytes: u64,
    max_event_bytes: u64,
    watch_changes: u64,
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
                watch_changes: 3
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

    /// The frontend reads the same file; a constant edited on one side only is the drift this catches.
    #[test]
    fn the_ipc_budget_matches_the_shared_file() {
        const BUDGET: &str = include_str!("../../../shared/ipc-budget.json");
        let budget: serde_json::Value = serde_json::from_str(BUDGET).unwrap();
        assert_eq!(budget["targetMessageBytes"], IPC_TARGET_BYTES);
        assert_eq!(budget["maxMessageBytes"], IPC_LIMIT_BYTES);
    }
}
