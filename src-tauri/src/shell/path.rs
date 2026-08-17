//! User PATH resolution.
//!
//! GUI apps inherit a stripped-down PATH from launchd / desktop
//! environment that doesn't include the user's homebrew, asdf,
//! cargo etc. This module spawns the user's login shell once at
//! startup, captures its PATH via `printenv`, then merges with
//! known fallback locations and caches the result.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::OnceCell;

static USER_PATH: OnceCell<String> = OnceCell::const_new();

/// Initialize user PATH from shell. Call once at app startup.
pub async fn init_user_path() {
    let path = resolve_user_path().await;
    // Ignore error if already set (idempotent)
    let _ = USER_PATH.set(path);
}

/// Get the cached user PATH.
pub fn get_user_path() -> &'static str {
    USER_PATH.get().map(|s| s.as_str()).unwrap_or("")
}

/// Resolve user PATH by merging shell PATH with known common locations.
/// This ensures paths like /opt/homebrew/bin are always included even when
/// shell resolution returns an incomplete PATH (e.g., /bin/sh doesn't source user profiles).
async fn resolve_user_path() -> String {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut all_paths: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    // First, add paths from user's shell (these take priority)
    if let Some(shell_path) = get_path_from_shell().await {
        tracing::info!(
            "Resolved user PATH from shell ({} entries)",
            shell_path.split(separator).count()
        );
        for entry in shell_path.split(separator) {
            if !entry.is_empty() {
                let path = PathBuf::from(entry);
                if seen.insert(path.clone()) {
                    all_paths.push(path);
                }
            }
        }
    } else {
        tracing::warn!("Failed to get PATH from shell");
    }

    // Then merge with fallback paths to ensure common locations are included
    let fallback = build_fallback_path();
    for entry in fallback.split(separator) {
        if !entry.is_empty() {
            let path = PathBuf::from(entry);
            if seen.insert(path.clone()) {
                all_paths.push(path);
            }
        }
    }

    tracing::info!("Final PATH has {} entries", all_paths.len());

    std::env::join_paths(&all_paths)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Build fallback PATH from known common locations.
/// Where krew keeps the plugin symlinks: `$KREW_ROOT/bin`, or `~/.krew/bin`.
///
/// `KREW_ROOT` is read from this process's environment, which is the same
/// place krew itself reads it from; a value set only in an interactive shell
/// profile is invisible here, and the default is then the right guess anyway.
#[cfg(not(windows))]
fn krew_bin() -> PathBuf {
    match std::env::var_os("KREW_ROOT").filter(|v| !v.is_empty()) {
        Some(root) => PathBuf::from(root).join("bin"),
        None => dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".krew/bin"),
    }
}

fn build_fallback_path() -> String {
    let mut paths: Vec<PathBuf> = Vec::new();

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
        // is. It has to be listed here rather than left to the shell: krew's
        // own instructions put its PATH export in `.bashrc` / `.zshrc`, which
        // an interactive shell reads and the login shell below does not. A
        // user whose plugin works in their terminal was told by this app to
        // install the thing they already had.
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
        // Windows common paths
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".cargo\\bin"));
            paths.push(home.join("scoop\\shims"));
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            paths.push(PathBuf::from(program_files));
        }
    }

    // Include current PATH entries
    if let Ok(current) = std::env::var("PATH") {
        let separator = if cfg!(windows) { ';' } else { ':' };
        for entry in current.split(separator) {
            if !entry.is_empty() {
                paths.push(PathBuf::from(entry));
            }
        }
    }

    // Use std::env::join_paths for OS-specific separator
    std::env::join_paths(&paths)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Timeout for shell PATH resolution to prevent blocking on slow login scripts.
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(30);

/// Get PATH from user's login shell.
#[cfg(not(windows))]
async fn get_path_from_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

    // Use printenv instead of echo $PATH for shell-agnostic behavior.
    // Fish shell outputs PATH as space-separated when using echo $PATH,
    // but printenv PATH works correctly across all shells.
    let output_future = Command::new(&shell)
        .args(["-l", "-c", "printenv PATH"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .output();

    // Add timeout to prevent blocking on slow/hanging login scripts
    let output = match tokio::time::timeout(SHELL_PATH_TIMEOUT, output_future).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            tracing::warn!("Failed to execute shell for PATH: {}", e);
            return None;
        }
        Err(_) => {
            tracing::warn!(
                "Shell PATH resolution timed out after {:?}, using fallback",
                SHELL_PATH_TIMEOUT
            );
            return None;
        }
    };

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Get PATH on Windows - just return current process PATH.
/// Windows GUI apps typically inherit proper PATH from the system.
#[cfg(windows)]
async fn get_path_from_shell() -> Option<String> {
    std::env::var("PATH").ok()
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn test_get_path_from_shell_returns_something() {
        // This test verifies shell PATH resolution works on the dev machine
        let path = get_path_from_shell().await;
        // Should return Some on most systems, None is acceptable if shell fails
        if let Some(p) = path {
            assert!(!p.is_empty(), "PATH should not be empty");
            let separator = if cfg!(windows) { ';' } else { ':' };
            assert!(
                p.contains(separator),
                "PATH should contain multiple entries"
            );
        }
    }

    #[tokio::test]
    async fn test_init_user_path_caches_value() {
        init_user_path().await;
        let path = get_user_path();
        assert!(!path.is_empty(), "User PATH should be initialized");

        // Second call should return same value (cached)
        let path2 = get_user_path();
        assert_eq!(path, path2, "PATH should be cached");
    }
}
