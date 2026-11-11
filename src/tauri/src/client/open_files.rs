//! kube speaks HTTP/1.1 only, so every watch holds a socket of its own, and
//! an app started from Finder or the Dock inherits launchd's 256 open files.
//! The ownership index alone watches every kind, a few hundred on a platform
//! cluster; past the limit every socket and file the app opens fails.

/// What the soft limit is raised to: macOS's `OPEN_MAX`, the most it allows
/// one process whatever the hard limit says.
const WANTED: libc::rlim_t = 10_240;

/// Raises the soft limit on open files towards the hard one, never lowers it.
pub fn raise() {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit(2) writes the struct it is handed and nothing else.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut limit) } != 0 {
        return;
    }
    let Some(soft) = raised(limit.rlim_cur, limit.rlim_max) else {
        return;
    };
    let from = limit.rlim_cur;
    limit.rlim_cur = soft;
    // SAFETY: setrlimit(2) reads the struct it is handed and nothing else.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const limit) } == 0 {
        tracing::info!(from, to = soft, "raised the open-files limit");
    } else {
        let error = std::io::Error::last_os_error();
        tracing::warn!(from, %error, "could not raise the open-files limit");
    }
}

/// How many files this process may hold open; `None` where nothing says.
#[must_use]
pub fn allowed() -> Option<u64> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit(2) writes the struct it is handed and nothing else.
    (unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut limit) } == 0).then_some(limit.rlim_cur)
}

/// The soft limit to ask for; `None` where the one held is already as high.
fn raised(soft: libc::rlim_t, hard: libc::rlim_t) -> Option<libc::rlim_t> {
    let wanted = WANTED.min(hard);
    (wanted > soft).then_some(wanted)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// launchd hands a Finder-launched app 256 and no hard limit, fewer than
    /// a watch per kind on a platform cluster. Fails if that limit is kept.
    #[test]
    fn a_finder_launched_app_gets_room_for_a_watch_per_kind() {
        assert_eq!(raised(256, libc::RLIM_INFINITY), Some(WANTED));
        assert_eq!(raised(256, 1_024), Some(1_024));
    }

    /// A shell that already raised the limit is not undone.
    #[test]
    fn a_limit_already_as_high_is_left_alone() {
        assert_eq!(raised(1_048_576, libc::RLIM_INFINITY), None);
        assert_eq!(raised(1_024, 1_024), None);
    }
}
