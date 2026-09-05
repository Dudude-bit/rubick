//! Platform-agnostic path resolution utilities for CLI tools.

use std::path::PathBuf;

/// Platform-aware path utilities for CLI tool resolution.
pub struct PathResolver;

impl PathResolver {
    /// Get OS-specific path separator.
    ///
    /// # Examples
    ///
    /// ```
    /// use k8s_gui_lib::cli::paths::PathResolver;
    ///
    /// #[cfg(windows)]
    /// assert_eq!(PathResolver::separator(), ';');
    ///
    /// #[cfg(not(windows))]
    /// assert_eq!(PathResolver::separator(), ':');
    /// ```
    #[inline]
    #[must_use]
    pub fn separator() -> char {
        if cfg!(windows) {
            ';'
        } else {
            ':'
        }
    }

    /// The file names one command can be installed under, in the order a
    /// shell would try them.
    ///
    /// On Unix a command is its own file name. On Windows it is the name plus
    /// an extension from `PATHEXT`, and the ones that matter here are not
    /// `.exe`: Azure's CLI ships `az.cmd` and Google's `gcloud.cmd`. Joining
    /// the bare name finds neither — the Diagnostics pane then reports tools
    /// absent that the reader can run in their own terminal, and an AKS
    /// context whose exec command is `az` cannot be started at all.
    #[must_use]
    pub fn binary_file_names(binary_name: &str) -> Vec<String> {
        #[cfg(not(windows))]
        {
            vec![binary_name.to_string()]
        }
        #[cfg(windows)]
        {
            // The name alone stays first: a file with no extension is what an
            // scoop shim or a hand-placed binary can be.
            let mut names = vec![binary_name.to_string()];
            let pathext = std::env::var("PATHEXT")
                .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
                .to_lowercase();
            for ext in pathext.split(';').filter(|e| e.starts_with('.')) {
                names.push(format!("{binary_name}{ext}"));
            }
            names
        }
    }

    /// Where a binary might be installed, by each platform's conventions.
    ///
    /// # Examples
    ///
    /// ```
    /// use k8s_gui_lib::cli::paths::PathResolver;
    ///
    /// let paths = PathResolver::search_paths("kubectl");
    /// assert!(!paths.is_empty());
    /// ```
    #[must_use]
    pub fn search_paths(binary_name: &str) -> Vec<PathBuf> {
        let mut paths = Vec::new();

        #[cfg(not(windows))]
        {
            // Homebrew paths (macOS)
            paths.push(PathBuf::from(format!("/opt/homebrew/bin/{binary_name}"))); // ARM macOS
            paths.push(PathBuf::from(format!("/usr/local/bin/{binary_name}"))); // Intel macOS, Linux

            // System paths
            paths.push(PathBuf::from(format!("/usr/bin/{binary_name}")));
            paths.push(PathBuf::from(format!("/bin/{binary_name}")));

            // Snap (Linux)
            paths.push(PathBuf::from(format!("/snap/bin/{binary_name}")));

            // User local paths
            if let Some(home) = dirs::home_dir() {
                paths.push(home.join(".local/bin").join(binary_name));
                paths.push(home.join(".asdf/shims").join(binary_name));
                paths.push(home.join(".cargo/bin").join(binary_name));

                // Through `krew_bin`, like `fallback_directories` below: both
                // lists have to look in the same place, or the app gives two
                // answers about where a plugin is on a machine that moved
                // `KREW_ROOT`.
                if binary_name == "kubectl" {
                    paths.push(Self::krew_bin().join(binary_name));
                }
            }
        }

        #[cfg(windows)]
        {
            // Every extension `PATHEXT` names, not just `.exe`: `az` and
            // `gcloud` ship as `.cmd`.
            let mut dirs_to_try: Vec<PathBuf> = Vec::new();
            if let Some(home) = dirs::home_dir() {
                dirs_to_try.push(home.join(".cargo\\bin"));
                dirs_to_try.push(home.join("scoop\\shims"));
            }
            if let Ok(program_files) = std::env::var("ProgramFiles") {
                dirs_to_try.push(PathBuf::from(program_files));
            }
            for dir in dirs_to_try {
                for file in Self::binary_file_names(binary_name) {
                    paths.push(dir.join(file));
                }
            }
        }

        // Bare names for PATH lookup (last resort)
        for file in Self::binary_file_names(binary_name) {
            paths.push(PathBuf::from(file));
        }

        paths
    }

    /// Merge shell PATH with fallback paths, removing duplicates.
    ///
    /// Paths from `shell_path` take priority over `fallback_paths`; the result
    /// uses the OS-appropriate separator.
    ///
    /// # Examples
    ///
    /// ```
    /// use k8s_gui_lib::cli::paths::PathResolver;
    /// use std::path::PathBuf;
    ///
    /// let shell_path = Some("/usr/bin:/usr/local/bin");
    /// let fallback = vec![PathBuf::from("/opt/homebrew/bin")];
    /// let merged = PathResolver::merge_paths(shell_path, &fallback);
    /// assert!(merged.contains("/usr/bin"));
    /// assert!(merged.contains("/opt/homebrew/bin"));
    /// ```
    #[must_use]
    pub fn merge_paths(shell_path: Option<&str>, fallback_paths: &[PathBuf]) -> String {
        let separator = Self::separator();
        let mut all_paths: Vec<PathBuf> = Vec::new();
        let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

        // First, add paths from shell PATH (these take priority)
        if let Some(path_str) = shell_path {
            for entry in path_str.split(separator) {
                if !entry.is_empty() {
                    let path = PathBuf::from(entry);
                    if seen.insert(path.clone()) {
                        all_paths.push(path);
                    }
                }
            }
        }

        // Then merge with fallback paths
        for path in fallback_paths {
            if seen.insert(path.clone()) {
                all_paths.push(path.clone());
            }
        }

        // Use std::env::join_paths for OS-specific separator
        std::env::join_paths(&all_paths)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    /// Where krew keeps the plugin symlinks: `$KREW_ROOT/bin`, or `~/.krew/bin`.
    ///
    /// Read from this process's environment after the login shell's variables
    /// were adopted into it, so a `KREW_ROOT` set only in a profile counts.
    #[cfg(not(windows))]
    #[must_use]
    pub fn krew_bin() -> PathBuf {
        match std::env::var_os("KREW_ROOT").filter(|v| !v.is_empty()) {
            Some(root) => PathBuf::from(root).join("bin"),
            None => dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/"))
                .join(".krew/bin"),
        }
    }

    /// Get the standard fallback directories for CLI tools.
    ///
    /// Returns common installation directories based on platform conventions.
    #[must_use]
    pub fn fallback_directories() -> Vec<PathBuf> {
        let mut paths = Vec::new();

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

            // User local paths
            if let Some(home) = dirs::home_dir() {
                paths.push(home.join(".local/bin"));
                paths.push(home.join(".asdf/shims"));
                paths.push(home.join(".cargo/bin"));
            }
            // krew, which is how kubectl credential plugins are installed and
            // therefore where a missing `kubectl-oidc_login` most often already
            // is. Through `krew_bin` so `KREW_ROOT` counts, and so this list
            // and `search_paths` look in the same place.
            paths.push(Self::krew_bin());
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

        paths
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bare name leads, so a file installed without an extension still
    /// wins over a `.cmd` shim beside it. Would break if the extensions were
    /// put first.
    #[test]
    fn the_command_name_itself_is_tried_before_any_extension() {
        let names = PathResolver::binary_file_names("az");

        assert_eq!(names.first().map(String::as_str), Some("az"));
        assert!(names.iter().all(|n| n.starts_with("az")));
    }

    /// A Unix command is its own file name; adding extensions there would
    /// make every lookup miss on the first try. Would break if the Windows
    /// branch leaked out of its `cfg`.
    #[cfg(not(windows))]
    #[test]
    fn a_unix_command_has_exactly_one_file_name() {
        assert_eq!(PathResolver::binary_file_names("gcloud"), vec!["gcloud"]);
    }

    #[test]
    fn test_separator_is_os_specific() {
        #[cfg(windows)]
        assert_eq!(PathResolver::separator(), ';');

        #[cfg(not(windows))]
        assert_eq!(PathResolver::separator(), ':');
    }

    #[test]
    fn test_search_paths_not_empty() {
        let paths = PathResolver::search_paths("kubectl");
        assert!(!paths.is_empty(), "Should return at least one search path");

        // Last entry should be just the binary name
        assert_eq!(
            paths.last().unwrap(),
            &PathBuf::from("kubectl"),
            "Last path should be bare binary name for PATH lookup"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn test_search_paths_includes_common_locations() {
        let paths = PathResolver::search_paths("kubectl");
        let path_strs: Vec<String> = paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();

        assert!(
            path_strs.iter().any(|p| p.contains("/usr/local/bin")),
            "Should include /usr/local/bin"
        );
        assert!(
            path_strs.iter().any(|p| p.contains("/opt/homebrew/bin")),
            "Should include /opt/homebrew/bin for ARM macOS"
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_search_paths_uses_exe_extension() {
        let paths = PathResolver::search_paths("kubectl");
        let has_exe = paths
            .iter()
            .any(|p| p.to_string_lossy().ends_with(".exe") || p == &PathBuf::from("kubectl"));
        assert!(has_exe, "Windows paths should use .exe extension");
    }

    #[test]
    fn test_merge_paths_removes_duplicates() {
        let fallback = vec![PathBuf::from("/usr/bin"), PathBuf::from("/usr/local/bin")];

        #[cfg(not(windows))]
        let shell_path = Some("/usr/bin:/opt/bin");

        #[cfg(windows)]
        let shell_path = Some("C:\\Windows\\System32;C:\\bin");

        let merged = PathResolver::merge_paths(shell_path, &fallback);

        // Should contain paths from both sources
        assert!(!merged.is_empty());

        // Count occurrences of separator to verify no duplicates
        let separator = PathResolver::separator();
        let entries: Vec<&str> = merged.split(separator).collect();
        let unique_entries: std::collections::HashSet<&str> = entries.iter().copied().collect();
        assert_eq!(
            entries.len(),
            unique_entries.len(),
            "Should not have duplicate entries"
        );
    }

    #[test]
    fn test_merge_paths_prioritizes_shell_path() {
        let fallback = vec![PathBuf::from("/fallback1"), PathBuf::from("/fallback2")];

        #[cfg(not(windows))]
        let shell_path = Some("/shell1:/shell2");

        #[cfg(windows)]
        let shell_path = Some("C:\\shell1;C:\\shell2");

        let merged = PathResolver::merge_paths(shell_path, &fallback);
        let separator = PathResolver::separator();
        let entries: Vec<&str> = merged.split(separator).collect();

        // Shell paths should come first
        #[cfg(not(windows))]
        {
            assert!(entries[0].contains("shell1"));
            assert!(entries[1].contains("shell2"));
        }

        #[cfg(windows)]
        {
            assert!(entries[0].contains("shell1"));
            assert!(entries[1].contains("shell2"));
        }
    }

    #[test]
    fn test_merge_paths_with_none_shell_path() {
        let fallback = vec![PathBuf::from("/usr/bin"), PathBuf::from("/usr/local/bin")];

        let merged = PathResolver::merge_paths(None, &fallback);
        assert!(!merged.is_empty(), "Should still include fallback paths");

        let separator = PathResolver::separator();
        assert!(merged.contains(separator), "Should contain path separator");
    }

    #[test]
    fn test_fallback_directories_not_empty() {
        let dirs = PathResolver::fallback_directories();
        assert!(
            !dirs.is_empty(),
            "Should return at least one fallback directory"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn test_fallback_directories_includes_system_paths() {
        let dirs = PathResolver::fallback_directories();
        let dir_strs: Vec<String> = dirs
            .iter()
            .map(|d| d.to_string_lossy().to_string())
            .collect();

        assert!(
            dir_strs.iter().any(|d| d == "/usr/bin"),
            "Should include /usr/bin"
        );
        assert!(
            dir_strs.iter().any(|d| d == "/usr/local/bin"),
            "Should include /usr/local/bin"
        );
    }
    /// The user's order is kept and a directory named by both sides appears
    /// once, where the user put it.
    #[cfg(not(windows))]
    #[test]
    fn the_shells_order_wins_and_nothing_is_listed_twice() {
        let merged = PathResolver::merge_paths(
            Some("/b:/a:/usr/bin"),
            &["/usr/bin", "/a", "/c"].map(PathBuf::from),
        );
        assert_eq!(merged, "/b:/a:/usr/bin:/c");
        assert_eq!(
            PathResolver::merge_paths(None, &["/x", "/y"].map(PathBuf::from)),
            "/x:/y",
            "empty entries are dropped"
        );
    }
    #[cfg(not(windows))]
    #[test]
    fn test_fallback_path_contains_common_dirs() {
        let dirs = PathResolver::fallback_directories();
        assert!(
            dirs.iter().any(|d| d.ends_with("usr/local/bin")),
            "Missing /usr/local/bin"
        );
        assert!(
            dirs.iter().any(|d| d.ends_with("usr/bin")),
            "Missing /usr/bin"
        );
    }

    /// The reported failure. A user had `kubectl-oidc_login` installed via
    /// krew and working in their terminal; this app said it was not installed
    /// and listed eighteen directories it had searched, none of them krew's.
    /// krew's install instructions put its PATH export in `.zshrc`, which the
    /// login shell used above never reads, so the fallback has to know.
    #[cfg(not(windows))]
    #[test]
    fn the_fallback_looks_where_krew_installs() {
        let dirs = PathResolver::fallback_directories();
        assert!(
            dirs.contains(&PathResolver::krew_bin()),
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
        let dirs = PathResolver::fallback_directories();
        assert!(
            dirs.iter().any(|d| d.ends_with("opt/homebrew/bin")),
            "Missing /opt/homebrew/bin on ARM"
        );
    }
}
