//! What the backend pushed over the IPC bridge while a recording ran.
//!
//! Counting bytes means serialising every event a second time, so nothing is
//! counted until the frontend asks for a recording, and the counters reset
//! when it does: a report is one run, not the process's whole life.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Default)]
pub struct PerfCounters {
    recording: AtomicBool,
    events_emitted: AtomicU64,
    event_bytes: AtomicU64,
    max_event_bytes: AtomicU64,
    watch_changes: AtomicU64,
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
        if on {
            self.events_emitted.store(0, Ordering::Relaxed);
            self.event_bytes.store(0, Ordering::Relaxed);
            self.max_event_bytes.store(0, Ordering::Relaxed);
            self.watch_changes.store(0, Ordering::Relaxed);
        }
        self.recording.store(on, Ordering::Relaxed);
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::Relaxed)
    }

    /// One event went out: how many bytes its payload serialised to, and how
    /// many watch changes it carried (zero for anything but a watch batch).
    pub fn observe(&self, bytes: usize, watch_changes: usize) {
        if !self.is_recording() {
            return;
        }
        let bytes = bytes as u64;
        self.events_emitted.fetch_add(1, Ordering::Relaxed);
        self.event_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.max_event_bytes.fetch_max(bytes, Ordering::Relaxed);
        self.watch_changes
            .fetch_add(watch_changes as u64, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> PerfSnapshot {
        PerfSnapshot {
            recording: self.is_recording(),
            events_emitted: self.events_emitted.load(Ordering::Relaxed),
            event_bytes: self.event_bytes.load(Ordering::Relaxed),
            max_event_bytes: self.max_event_bytes.load(Ordering::Relaxed),
            watch_changes: self.watch_changes.load(Ordering::Relaxed),
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
        let s = c.snapshot();
        assert_eq!(
            s,
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
}
