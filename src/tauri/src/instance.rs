//! Whether a running instance is up to take a later launch's link.
//!
//! A `rubick://` link opened while the app runs starts a second process,
//! which the single-instance plugin ends once its arguments are handed over.
//! That happens inside Tauri's setup, after `main` has waited on the login
//! shell for an environment this process never uses. The lock here is what
//! `main` can read before that wait.

use std::fs::{File, TryLockError};
use std::path::Path;
use std::sync::OnceLock;

const LOCK_FILE: &str = "rubick.instance.lock";

/// Set on the launch started in place of one that left the login shell
/// unasked and then found nobody to hand over to. It asks, whatever the lock
/// says, so a holder that never takes a link costs one start-over, not a loop.
pub const START_WHOLE: &str = "RUBICK_START_WHOLE";

static HELD: OnceLock<File> = OnceLock::new();

/// Whether another process holds the lock. `false` wherever that cannot be
/// read: a launch that cannot tell starts whole.
#[must_use]
pub fn is_up(dir: &Path) -> bool {
    File::open(dir.join(LOCK_FILE))
        .is_ok_and(|lock| matches!(lock.try_lock_shared(), Err(TryLockError::WouldBlock)))
}

/// Whether this launch leaves the login shell unasked: an instance is up to
/// take its link, and it was not started `whole`. Unix only, which is where
/// the wait is.
#[must_use]
pub fn hands_over(whole: bool, dir: Option<&Path>) -> bool {
    cfg!(unix) && !whole && dir.is_some_and(is_up)
}

fn take(dir: &Path) -> Option<File> {
    std::fs::create_dir_all(dir).ok()?;
    let lock = File::create(dir.join(LOCK_FILE)).ok()?;
    lock.try_lock().ok().map(|()| lock)
}

/// Holds the lock for as long as this process runs. Called from Tauri's
/// setup, which is after the single-instance plugin registered: a holder is
/// an instance a launch can hand over to.
pub fn hold(dir: &Path) {
    if let Some(lock) = take(dir) {
        let _ = HELD.set(lock);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rubick-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// A launch that takes a lock file left by an instance that quit for a
    /// running one skips the login shell and comes up with no `PATH`; one
    /// that misses a running instance waits on the profile before its link
    /// opens. Fails if the answer is anything but "held right now".
    #[test]
    fn a_launch_finds_a_running_instance_only_while_one_holds_the_lock() {
        let dir = scratch("instance-up");
        assert!(!is_up(&dir), "no instance has ever run");

        let running = take(&dir).expect("the first launch holds the lock");
        assert!(is_up(&dir));
        assert!(is_up(&dir), "asking does not take it from the holder");

        drop(running);
        assert!(
            !is_up(&dir),
            "the file outlives the instance; the lock does not"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A holder that takes no link (no session bus, a hung instance) would
    /// otherwise start every launch over, each one skipping the shell again.
    /// Fails if a launch started whole leaves the login shell unasked, or if
    /// one with no folder to look in does.
    #[test]
    fn a_launch_started_whole_asks_the_login_shell_whoever_holds_the_lock() {
        let dir = scratch("instance-whole");
        let _running = take(&dir).expect("held");

        assert_eq!(hands_over(false, Some(&dir)), cfg!(unix));
        assert!(!hands_over(true, Some(&dir)));
        assert!(!hands_over(false, None));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
