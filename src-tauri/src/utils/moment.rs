//! The one place a cluster's timestamp becomes this app's.
//!
//! `k8s-openapi` 0.28 moved `Time` off `chrono` and onto `jiff`. Everything
//! else here counts time in `chrono` — credential deadlines, the age columns,
//! the log window — and nothing is served by having two clocks. So the
//! conversion happens once, here, at the boundary where a cluster's word
//! arrives, rather than at each of the thirty-odd places that read a
//! timestamp off an object.
//!
//! Named rather than spelled out on purpose: `t.0` at every call site is how
//! a field ends up read one way in the list and another in the detail, which
//! is the defect this project keeps finding. One reader, one answer.

use chrono::{DateTime, Utc};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{MicroTime, Time};

/// The moment a Kubernetes timestamp names.
pub trait Moment {
    /// This timestamp as `chrono` counts time.
    ///
    /// A `jiff::Timestamp` is a count of seconds and nanoseconds from the
    /// same epoch, so the conversion is exact and cannot fail for any instant
    /// a cluster can express — `DateTime::from_timestamp` only refuses years
    /// beyond ±262143, which `Timestamp` cannot hold either.
    fn moment(&self) -> DateTime<Utc>;
}

fn crossing(stamp: k8s_openapi::jiff::Timestamp) -> DateTime<Utc> {
    // `jiff` puts the sign on both halves — `-0.5s` is second 0, nanosecond
    // -500_000_000 — while `chrono` wants a fraction to add to the second.
    // Handed the fraction unsigned, an instant before the epoch moves forward
    // by twice it.
    let (mut second, mut nanosecond) = (stamp.as_second(), stamp.subsec_nanosecond());
    if nanosecond < 0 {
        second -= 1;
        nanosecond += 1_000_000_000;
    }
    // Cannot fail: `jiff` spans years -9999..=9999 and `chrono` refuses only
    // beyond ±262143, so every instant a cluster can express fits.
    DateTime::from_timestamp(second, nanosecond.unsigned_abs()).unwrap_or_default()
}

impl Moment for Time {
    fn moment(&self) -> DateTime<Utc> {
        crossing(self.0)
    }
}

/// `MicroTime` is the same instant to microsecond resolution — events carry
/// it where `Time` would round two of them onto the same second. It crosses
/// the same way, and having it here is what stops a caller reaching for `.0`
/// again the moment it meets one.
impl Moment for MicroTime {
    fn moment(&self) -> DateTime<Utc> {
        crossing(self.0)
    }
}

/// The other direction: an instant this app chose, as the cluster takes it.
///
/// `LogParams::since_time` is the one place we hand a time *to* Kubernetes,
/// and it moved to `jiff` with everything else. Here rather than at the call
/// site for the same reason the crossing above is: two conversions written
/// separately are two chances to disagree about what the instant was.
///
/// `None` for an instant `jiff` cannot hold. The caller must not substitute
/// one of its own: the only reader is `LogParams::since_time`, and a stand-in
/// epoch there asks the cluster for every line it has ever kept.
#[must_use]
pub fn as_cluster_time(at: DateTime<Utc>) -> Option<k8s_openapi::jiff::Timestamp> {
    let nanosecond = i32::try_from(at.timestamp_subsec_nanos()).ok()?;
    k8s_openapi::jiff::Timestamp::new(at.timestamp(), nanosecond).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(rfc3339: &str) -> Time {
        Time(rfc3339.parse().expect("a timestamp this test wrote itself"))
    }

    /// The whole point of the boundary: what the cluster said comes out the
    /// other side unchanged. Would break if the seconds and the nanoseconds
    /// were read off different clocks.
    #[test]
    fn a_cluster_timestamp_keeps_the_instant_it_named() {
        assert_eq!(
            at("2026-09-06T11:22:33Z").moment().to_rfc3339(),
            "2026-09-06T11:22:33+00:00"
        );
    }

    /// Kubernetes writes `creationTimestamp` to the second, but a
    /// `metadata.managedFields` entry and an event's `eventTime` carry
    /// microseconds. Would break if the sub-second part were dropped.
    #[test]
    fn the_sub_second_part_survives_the_crossing() {
        let crossed = at("2026-09-06T11:22:33.123456Z").moment();

        assert_eq!(crossed.timestamp_subsec_nanos(), 123_456_000);
    }

    /// A cluster whose clock predates 1970 is not a cluster anyone has, but
    /// the sign handling is the kind of thing that is wrong in one direction
    /// and never noticed. `jiff` carries the sign on the fraction as well as
    /// the seconds — `-0.5s` is second `0`, nanosecond `-500_000_000` — while
    /// `chrono` wants a fraction added to the second. Taking the absolute
    /// value of the fraction moves the instant forward by twice it. Would
    /// break with the whole second the earlier version of this test used,
    /// which has no fraction to get the sign wrong.
    #[test]
    fn an_instant_before_the_epoch_is_not_read_forwards() {
        let before = at("1969-12-31T23:59:59.5Z").moment();

        assert_eq!(before.to_rfc3339(), "1969-12-31T23:59:59.500+00:00");
    }
}
