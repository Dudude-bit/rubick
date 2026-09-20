//! `FailureLatch` — the small state machine that decides whether the
//! watcher loop should emit a `Failed` op to the frontend.
//!
//! kube's runtime watcher retries on its own with backoff. We don't
//! want a single 503 from a stressed apiserver to show as "watch
//! failed, falling back to polling" in the UI — that flickers between
//! states. We do want a permanent denial (403 from a missing `watch`
//! verb) to surface so the UI can switch to periodic refresh.
//!
//! The compromise: emit `Failed` only after `THRESHOLD` consecutive
//! errors with no successful event between them, and only once per
//! streak. A successful event resets both the counter and the
//! emit-once latch, so a recovered stream is free to fail again later
//! and trigger another `Failed` event after another full streak.

use kube::runtime::watcher::Event;
use std::time::Duration;

const ERROR_THRESHOLD: u32 = 3;

/// Whether a watcher event is the cluster answering, or only a marker that
/// another attempt has begun.
///
/// kube emits `Event::Init` *before* it attempts the initial list, so a
/// refused stream yields `Init, Err, Init, Err` for ever. Counting `Init` as
/// a success reset the streak between every pair of errors: `rubick.log`
/// held 7598 `error (1 in a row)` lines under a 403 and not one `(2 in a
/// row)`, so the refusal never left this process.
pub(crate) fn answered<K>(event: &Event<K>) -> bool {
    !matches!(event, Event::Init)
}

/// First wait after an error, doubled per error in the streak.
const BACKOFF_BASE: Duration = Duration::from_secs(1);

/// Longest wait between attempts. kube's own default stops here too.
const BACKOFF_CAP: Duration = Duration::from_secs(30);

/// How long to wait before re-listing, after `errors` failures in a row.
///
/// kube's own `StreamBackoff` resets on any non-error item and `Event::Init`
/// is one, so a refused stream kept its ramp on the first rung — about one
/// re-list a second, for ever. The streak this takes survives the marker.
pub(crate) fn backoff_for(errors: u32) -> Duration {
    let doublings = errors.saturating_sub(1).min(16);
    BACKOFF_BASE
        .saturating_mul(1u32 << doublings)
        .min(BACKOFF_CAP)
}

/// State machine for the watcher's "should we emit Failed yet?" decision.
pub(super) struct FailureLatch {
    consecutive_errors: u32,
    emitted: bool,
}

impl FailureLatch {
    pub fn new() -> Self {
        Self {
            consecutive_errors: 0,
            emitted: false,
        }
    }

    /// Record a successful watch event. Resets the counter and clears
    /// the emit-once latch so a future failure streak can trigger a
    /// fresh `Failed`.
    pub fn record_success(&mut self) {
        self.consecutive_errors = 0;
        self.emitted = false;
    }

    /// Record a watch error. Returns `true` exactly once per failure
    /// streak — when the threshold is reached. Subsequent errors in
    /// the same streak return `false` to avoid spamming the UI.
    pub fn record_error(&mut self) -> bool {
        self.consecutive_errors += 1;
        if self.consecutive_errors >= ERROR_THRESHOLD && !self.emitted {
            self.emitted = true;
            true
        } else {
            false
        }
    }

    /// Current consecutive-error count. Used only by the spawn
    /// closure for tracing.
    pub fn consecutive_errors(&self) -> u32 {
        self.consecutive_errors
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::Pod;

    /// Deleting this rule is how a permanent refusal stays inside the
    /// process: `Init` precedes every failed list, so counting it resets
    /// the streak the threshold is measured on.
    #[test]
    fn the_init_marker_is_not_the_cluster_answering() {
        assert!(!answered::<Pod>(&Event::Init));
    }

    /// The events that carry an object, and the one that says the list
    /// drained, are the cluster answering — a rule that called them
    /// markers would leave a healthy stream permanently in a streak.
    #[test]
    fn an_object_or_a_drained_list_is_an_answer() {
        assert!(answered(&Event::InitApply(Pod::default())));
        assert!(answered::<Pod>(&Event::InitDone));
        assert!(answered(&Event::Apply(Pod::default())));
        assert!(answered(&Event::Delete(Pod::default())));
    }

    /// Deleting the growth leaves a fixed wait, which is what the refused
    /// stream already had from kube's own backoff — about one re-list a
    /// second, for ever.
    #[test]
    fn the_wait_doubles_with_the_streak_and_stops_at_the_cap() {
        assert_eq!(backoff_for(1), Duration::from_secs(1));
        assert_eq!(backoff_for(2), Duration::from_secs(2));
        assert_eq!(backoff_for(3), Duration::from_secs(4));
        assert_eq!(backoff_for(6), Duration::from_secs(30), "capped");
        assert_eq!(backoff_for(99), Duration::from_secs(30), "stays capped");
    }

    /// A streak of zero is not a case the loop produces, and it must not
    /// panic or shift the first wait if it ever does.
    #[test]
    fn a_streak_of_none_waits_the_base() {
        assert_eq!(backoff_for(0), Duration::from_secs(1));
    }

    /// The pattern the log showed: a refused list is preceded by `Init`
    /// every time, and the latch must still reach its threshold.
    #[test]
    fn a_refused_stream_reaches_the_threshold_despite_its_markers() {
        let mut latch = FailureLatch::new();
        let mut emitted = false;
        for _ in 0..3 {
            if answered::<Pod>(&Event::Init) {
                latch.record_success();
            }
            emitted |= latch.record_error();
        }
        assert!(emitted, "three refused lists must emit Failed");
    }

    #[test]
    fn does_not_emit_below_threshold() {
        let mut latch = FailureLatch::new();
        assert!(!latch.record_error(), "1 error");
        assert!(!latch.record_error(), "2 errors");
    }

    #[test]
    fn emits_exactly_at_threshold() {
        let mut latch = FailureLatch::new();
        latch.record_error();
        latch.record_error();
        assert!(latch.record_error(), "third error must emit");
    }

    #[test]
    fn does_not_re_emit_within_same_streak() {
        let mut latch = FailureLatch::new();
        latch.record_error();
        latch.record_error();
        assert!(latch.record_error());
        assert!(!latch.record_error(), "fourth error must not re-emit");
        assert!(!latch.record_error(), "fifth error must not re-emit");
    }

    #[test]
    fn success_resets_counter_and_latch() {
        let mut latch = FailureLatch::new();
        latch.record_error();
        latch.record_error();
        assert!(latch.record_error(), "first streak emits");

        latch.record_success();

        assert!(!latch.record_error(), "1 error after recovery");
        assert!(!latch.record_error(), "2 errors after recovery");
        assert!(
            latch.record_error(),
            "3rd error after recovery must emit again"
        );
    }

    #[test]
    fn single_success_between_errors_resets_streak() {
        let mut latch = FailureLatch::new();
        latch.record_error();
        latch.record_error();
        // One success right before threshold should reset.
        latch.record_success();
        assert!(!latch.record_error(), "1 error after intermediate success");
        assert!(!latch.record_error(), "2 errors after intermediate success");
        assert!(latch.record_error(), "3rd must emit on fresh streak");
    }

    #[test]
    fn consecutive_errors_count_is_visible() {
        let mut latch = FailureLatch::new();
        assert_eq!(latch.consecutive_errors(), 0);
        latch.record_error();
        assert_eq!(latch.consecutive_errors(), 1);
        latch.record_error();
        assert_eq!(latch.consecutive_errors(), 2);
        latch.record_success();
        assert_eq!(latch.consecutive_errors(), 0);
    }
}
