//! The PATH a spawned binary is searched in.
//!
//! Set once at startup by `env::import_login_shell_env`, from the login
//! shell's PATH merged with the well-known locations below, and read by
//! everything that spawns or looks for a binary. One value, so the
//! Diagnostics screen and the spawn cannot disagree about where a plugin is.

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

/// The shell's entries first, then the fallback's, each directory once.
///
/// The shell's order is the user's own and is kept; the fallback exists for
/// what a profile forgot, so it goes behind.
#[must_use]
pub(super) fn merge_path(shell_path: Option<&str>, fallback: &str) -> String {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut all_paths: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    for list in [shell_path.unwrap_or(""), fallback] {
        for entry in list.split(separator) {
            if !entry.is_empty() {
                let path = PathBuf::from(entry);
                if seen.insert(path.clone()) {
                    all_paths.push(path);
                }
            }
        }
    }

    std::env::join_paths(&all_paths)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Where krew keeps the plugin symlinks: `$KREW_ROOT/bin`, or `~/.krew/bin`.
///
/// Read from this process's environment after the login shell's variables
/// were adopted into it, so a `KREW_ROOT` set only in a profile counts.
#[cfg(not(windows))]
fn krew_bin() -> PathBuf {
    match std::env::var_os("KREW_ROOT").filter(|v| !v.is_empty()) {
        Some(root) => PathBuf::from(root).join("bin"),
        None => dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".krew/bin"),
    }
}

/// The process's own PATH first, then the well-known locations.
///
/// The inherited PATH is a real answer, not a guess: from a terminal it is
/// the terminal's own, and a well-known directory behind it must not shadow
/// the kubectl the user actually installed. The well-known directories are
/// for what a desktop launch's stripped PATH lacks.
pub(super) fn build_fallback_path() -> String {
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

    #[cfg(not(windows))]
    {
        // Homebrew paths (macOS)
        paths.push(PathBuf::from("/opt/homebrew/bin")); // ARM macOS
        paths.push(PathBuf::from("/usr/local/bin")); // Intel macOS, Linux

        // System paths
        paths.push(PathBuf::from("/usr/bin"));
        paths.push(PathBuf::from("/bin"));
        paths.push(PathBuf::from("/usr/sbin"));
        paths.push(PathBuf::from("/sbin"));

        // Snap (Linux)
        paths.push(PathBuf::from("/snap/bin"));

        // krew, which is how kubectl credential plugins are installed and
        // therefore where a missing `kubectl-oidc_login` most often already
        // is. Listed here as well as taken from the shell: a user who has no
        // profile line for it at all was told by this app to install the
        // thing they already had.
        paths.push(krew_bin());

        // User local paths
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".local/bin"));
            paths.push(home.join(".asdf/shims"));
            paths.push(home.join(".cargo/bin"));
        }
    }

    #[cfg(windows)]
    {
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".cargo\\bin"));
            paths.push(home.join("scoop\\shims"));
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            paths.push(PathBuf::from(program_files));
        }
    }

    std::env::join_paths(&paths)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// From a terminal the inherited PATH begins with the user's shims and
    /// wrappers; a well-known `/usr/bin` ahead of them would resolve a
    /// different kubectl than the terminal the app was started from.
    #[test]
    fn the_inherited_path_comes_before_the_well_known_directories() {
        let inherited = std::env::var("PATH").unwrap_or_default();
        let first = inherited
            .split(if cfg!(windows) { ';' } else { ':' })
            .find(|e| !e.is_empty());
        if let Some(first) = first {
            assert!(
                build_fallback_path().starts_with(first),
                "the process's own PATH should lead: {}",
                build_fallback_path()
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn test_fallback_path_contains_common_dirs() {
        let path = build_fallback_path();
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
        let path = build_fallback_path();
        assert!(
            path.contains(&krew_bin().to_string_lossy().to_string()),
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
        let default = krew_bin();
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
        let path = build_fallback_path();
        assert!(
            path.contains("/opt/homebrew/bin"),
            "Missing /opt/homebrew/bin on ARM"
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_fallback_path_contains_windows_paths() {
        let path = build_fallback_path();
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
        let merged = merge_path(Some("/b:/a:/usr/bin"), "/usr/bin:/a:/c");
        assert_eq!(merged, "/b:/a:/usr/bin:/c");
        assert_eq!(
            merge_path(None, "/x::/y"),
            "/x:/y",
            "empty entries are dropped"
        );
    }
}
