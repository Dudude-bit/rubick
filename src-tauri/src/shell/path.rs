//! The PATH a spawned binary is searched in.
//!
//! Set once at startup by `env::import_login_shell_env`, from the login
//! shell's PATH merged with the well-known locations below, and read by
//! everything that spawns or looks for a binary. One value, so the
//! Diagnostics screen and the spawn cannot disagree about where a plugin is.

use crate::cli::PathResolver;
use std::path::PathBuf;
use std::sync::OnceLock;

static USER_PATH: OnceLock<String> = OnceLock::new();

/// Record the merged PATH. A second call is ignored; there is one startup.
pub(super) fn set_user_path(path: String) {
    let _ = USER_PATH.set(path);
}

/// The cached user PATH, or empty before startup has set it.
pub fn get_user_path() -> &'static str {
    USER_PATH.get().map_or("", std::string::String::as_str)
}

/// The process's own PATH first, then the well-known locations.
///
/// The inherited PATH is a real answer, not a guess: from a terminal it is the
/// terminal's own, and a well-known directory behind it must not shadow the
/// kubectl the user actually installed. The well-known directories are for what
/// a desktop launch's stripped PATH lacks, and they come from
/// `PathResolver::fallback_directories` — which is where krew's directory is
/// resolved too, so the two lists cannot disagree about `KREW_ROOT` the way
/// they did when each had its own copy.
#[must_use]
pub(super) fn build_fallback_path() -> Vec<PathBuf> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut paths: Vec<PathBuf> = std::env::var("PATH")
        .map(|current| {
            current
                .split(separator)
                .filter(|entry| !entry.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    paths.extend(PathResolver::fallback_directories());
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    /// From a terminal the inherited PATH begins with the user's shims and
    /// wrappers; a well-known `/usr/bin` ahead of them would resolve a
    /// different kubectl than the terminal the app was started from.
    /// The one thing this function decides for itself: everything else in the
    /// list comes from `PathResolver::fallback_directories`, and is tested
    /// beside it.
    #[test]
    fn the_inherited_path_comes_before_the_well_known_directories() {
        let inherited = std::env::var("PATH").unwrap_or_default();
        let first = inherited
            .split(if cfg!(windows) { ';' } else { ':' })
            .find(|e| !e.is_empty());

        if let Some(first) = first {
            let dirs = build_fallback_path();
            assert_eq!(
                dirs.first().map(std::path::PathBuf::as_path),
                Some(std::path::Path::new(first)),
                "the process's own PATH should lead: {dirs:?}"
            );
        }
    }
}
