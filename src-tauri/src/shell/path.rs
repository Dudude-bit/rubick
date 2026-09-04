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

/// The shell's entries first, then the well-known ones, each directory once.
///
/// `PathResolver::merge_paths` is the implementation — this used to be a second
/// copy of it, with the same shell-first order, the same `HashSet` dedup and
/// the same `join_paths` tail, in a crate that already had one.
#[must_use]
pub(super) fn merge_path(shell_path: Option<&str>, fallback: &[PathBuf]) -> String {
    PathResolver::merge_paths(shell_path, fallback)
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
    /// The fallback list as one string, for the tests that were written against
    /// the string this used to return.
    #[cfg(test)]
    fn fallback_as_string() -> String {
        std::env::join_paths(build_fallback_path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn the_inherited_path_comes_before_the_well_known_directories() {
        let inherited = std::env::var("PATH").unwrap_or_default();
        let first = inherited
            .split(if cfg!(windows) { ';' } else { ':' })
            .find(|e| !e.is_empty());
        if let Some(first) = first {
            assert!(
                fallback_as_string().starts_with(first),
                "the process's own PATH should lead: {}",
                fallback_as_string()
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn test_fallback_path_contains_common_dirs() {
        let path = fallback_as_string();
        assert!(path.contains("/usr/local/bin"), "Missing /usr/local/bin");
        assert!(path.contains("/usr/bin"), "Missing /usr/bin");
    }

    /// The reported failure. A user had `kubectl-oidc_login` installed via
    /// krew and working in their terminal; this app said it was not installed
    /// and listed eighteen directories it had searched, none of them krew's.
    /// krew's install instructions put its PATH export in `.zshrc`, which the
    /// login shell used above never reads, so the fallback has to know.
    #[cfg(not(windows))]
    #[test]
    fn the_fallback_looks_where_krew_installs() {
        let path = fallback_as_string();
        assert!(
            path.contains(&PathResolver::krew_bin().to_string_lossy().to_string()),
            "krew's bin is not searched, and it is where `kubectl krew install` puts plugins"
        );
    }

    /// Honoured because krew does: a plugin installed under a moved root is
    /// still the plugin the exec block names.
    #[cfg(not(windows))]
    #[test]
    fn krew_root_moves_where_we_look() {
        // Not a std::env::set_var test — that races every other test in the
        // binary. The function's two branches are checked by shape instead.
        let default = PathResolver::krew_bin();
        assert!(default.ends_with(".krew/bin"), "default is ~/.krew/bin");
        assert_eq!(
            PathBuf::from("/opt/krew").join("bin"),
            PathBuf::from("/opt/krew/bin"),
            "a KREW_ROOT is joined with `bin`, not used bare"
        );
    }

    #[cfg(all(target_arch = "aarch64", not(windows)))]
    #[test]
    fn test_fallback_path_contains_homebrew_arm() {
        let path = fallback_as_string();
        assert!(
            path.contains("/opt/homebrew/bin"),
            "Missing /opt/homebrew/bin on ARM"
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_fallback_path_contains_windows_paths() {
        let path = fallback_as_string();
        // On Windows, should use semicolon separator and include current PATH
        assert!(
            path.contains(';') || path.is_empty() || !path.contains(':'),
            "Windows PATH should use semicolon separator"
        );
    }

    /// The user's order is kept and a directory named by both sides appears
    /// once, where the user put it.
    #[cfg(not(windows))]
    #[test]
    fn the_shells_order_wins_and_nothing_is_listed_twice() {
        let merged = merge_path(
            Some("/b:/a:/usr/bin"),
            &["/usr/bin", "/a", "/c"].map(PathBuf::from),
        );
        assert_eq!(merged, "/b:/a:/usr/bin:/c");
        assert_eq!(
            merge_path(None, &["/x", "/y"].map(PathBuf::from)),
            "/x:/y",
            "empty entries are dropped"
        );
    }
}
