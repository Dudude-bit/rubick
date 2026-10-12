//! Who holds the names recent warnings give, for kinds the stores do not watch.
//!
//! A metadata read per name per poll was up to sixteen requests every five
//! seconds for answers that do not change: a uid is fixed while its object
//! exists. So a read is kept and stands in for the next ones until the events
//! name a uid it was not read against, which is a new object of the name, or
//! until it is older than [`REREAD_AFTER`], which is how a delete with nothing
//! in its place is found.

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// An object a warning names: kind, namespace where it has one, and name.
pub type Named = (String, Option<String>, String);

/// What a read of one named object found holding its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Held {
    By(String),
    Nobody,
}

/// How long a read answers for its name when the events name no new uid.
pub const REREAD_AFTER: Duration = Duration::from_secs(30);

struct Read {
    /// `None` is a read that could not say: refused, failed, or not served.
    held: Option<Held>,
    uids: BTreeSet<String>,
    at: Instant,
}

/// The reads one cluster's polls have made, by name.
#[derive(Default)]
pub struct HolderMemo {
    reads: Mutex<HashMap<Named, Read>>,
}

impl HolderMemo {
    /// What the last read found for `named`, if it still answers for a poll
    /// whose events give `uids` for that name at `now`. `None` is "read again".
    pub fn recall(
        &self,
        named: &Named,
        uids: &BTreeSet<String>,
        now: Instant,
    ) -> Option<Option<Held>> {
        let reads = self.reads.lock();
        let read = reads.get(named)?;
        (now.saturating_duration_since(read.at) < REREAD_AFTER && uids.is_subset(&read.uids))
            .then(|| read.held.clone())
    }

    pub fn remember(&self, named: Named, uids: BTreeSet<String>, held: Option<Held>, now: Instant) {
        let mut reads = self.reads.lock();
        reads.retain(|_, read| now.saturating_duration_since(read.at) < REREAD_AFTER);
        reads.insert(
            named,
            Read {
                held,
                uids,
                at: now,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hpa() -> Named {
        (
            "HorizontalPodAutoscaler".to_string(),
            Some("lena-sandbox".to_string()),
            "hello-web".to_string(),
        )
    }

    fn uids(of: &[&str]) -> BTreeSet<String> {
        of.iter().map(ToString::to_string).collect()
    }

    /// Fails if a read is not reused while nothing about its name changed, or
    /// if one goes on answering past the age a delete is found in.
    #[test]
    fn a_read_answers_for_its_name_until_it_is_old() {
        let memo = HolderMemo::default();
        let at = Instant::now();
        let held = Some(Held::By("8b3e3d88".to_string()));
        memo.remember(hpa(), uids(&["8b3e3d88"]), held.clone(), at);

        assert_eq!(
            memo.recall(&hpa(), &uids(&["8b3e3d88"]), at + REREAD_AFTER / 2),
            Some(held)
        );
        assert_eq!(
            memo.recall(&hpa(), &uids(&["8b3e3d88"]), at + REREAD_AFTER),
            None
        );
    }

    /// Lena's hello-web was deleted and made again: the new one's first
    /// warning names a uid the read never saw. Fails if that read goes on
    /// naming the old object as the holder.
    #[test]
    fn a_uid_the_read_never_saw_is_read_again_at_once() {
        let memo = HolderMemo::default();
        let at = Instant::now();
        memo.remember(
            hpa(),
            uids(&["c20ecc6d"]),
            Some(Held::By("c20ecc6d".to_string())),
            at,
        );

        assert_eq!(
            memo.recall(&hpa(), &uids(&["c20ecc6d", "8b3e3d88"]), at),
            None
        );
        assert_eq!(
            memo.recall(&hpa(), &uids(&["c20ecc6d"]), at),
            Some(Some(Held::By("c20ecc6d".to_string())))
        );
    }

    /// A refused read is not asked again every poll, and is not turned into
    /// an answer either. Fails if it is forgotten or recalled as a holder.
    #[test]
    fn a_read_that_could_not_say_is_kept_as_not_knowing() {
        let memo = HolderMemo::default();
        let at = Instant::now();
        memo.remember(hpa(), uids(&["8b3e3d88"]), None, at);
        assert_eq!(memo.recall(&hpa(), &uids(&["8b3e3d88"]), at), Some(None));
    }
}
