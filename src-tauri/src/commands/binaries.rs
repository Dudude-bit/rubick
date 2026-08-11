//! Where a named binary would be found, without running it.
//!
//! The Clusters screen says whether a context's credential plugin is
//! present. That answer has to come from the same PATH the app hands to
//! the plugin at connect time (`shell::get_user_path`), or the screen and
//! the connection would disagree about the same binary.
//!
//! Nothing here executes anything. A settings screen that shelled out to
//! every `command` named by a kubeconfig would be running arbitrary
//! binaries because somebody opened a pane.

use serde::{Deserialize, Serialize};

use crate::cli::PathResolver;
use crate::error::Result;

/// One binary that was asked about, and the file that would run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryLocation {
    /// Exactly what was asked for, so a caller can match answers to
    /// questions without relying on order.
    pub name: String,
    /// The file that would run, or `None` when nothing was found.
    pub path: Option<String>,
}

/// True when the path names an existing file the process could execute.
fn is_runnable(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return meta.permissions().mode() & 0o111 != 0;
    }
    #[cfg(not(unix))]
    true
}

fn expand_home(name: &str) -> std::path::PathBuf {
    match name.strip_prefix("~/") {
        Some(rest) => dirs::home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| std::path::PathBuf::from(name)),
        None => std::path::PathBuf::from(name),
    }
}

/// Resolve one binary name the way a shell would.
///
/// A name containing a separator is a path and is taken literally — the
/// shell would not search PATH for it either.
fn locate(name: &str, search_dirs: &[std::path::PathBuf]) -> Option<String> {
    let literal = expand_home(name);
    if literal.components().count() > 1 {
        return is_runnable(&literal).then(|| literal.to_string_lossy().into_owned());
    }
    search_dirs.iter().find_map(|dir| {
        let candidate = dir.join(name);
        is_runnable(&candidate).then(|| candidate.to_string_lossy().into_owned())
    })
}

/// Look up several binaries in one call.
///
/// Batched because the caller is a list: thirty contexts naming six
/// distinct plugins should be one round trip, not six.
#[tauri::command]
pub async fn locate_binaries(names: Vec<String>) -> Result<Vec<BinaryLocation>> {
    let separator = PathResolver::separator();
    let user_path = crate::shell::get_user_path();
    let mut search_dirs: Vec<std::path::PathBuf> = user_path
        .split(separator)
        .filter(|entry| !entry.is_empty())
        .map(std::path::PathBuf::from)
        .collect();
    if search_dirs.is_empty() {
        search_dirs = PathResolver::fallback_directories();
    }

    Ok(names
        .into_iter()
        .map(|name| BinaryLocation {
            path: locate(&name, &search_dirs),
            name,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_name_is_found_only_where_it_is_executable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let runnable = dir.path().join("kubelogin");
        std::fs::write(&runnable, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&runnable, std::fs::Permissions::from_mode(0o755)).unwrap();

        let inert = dir.path().join("notes");
        std::fs::write(&inert, b"not a program").unwrap();

        let dirs = vec![dir.path().to_path_buf()];
        assert!(locate("kubelogin", &dirs).is_some());
        assert_eq!(locate("notes", &dirs), None, "a plain file is not a tool");
        assert_eq!(locate("absent", &dirs), None);
    }

    /// An exec block may name an absolute path, and PATH has nothing to
    /// say about it — searching for its basename instead would report a
    /// different binary as the one that will run.
    #[test]
    fn a_path_is_taken_literally_rather_than_searched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let elsewhere = dir.path().join("kubelogin");
        std::fs::write(&elsewhere, b"x").unwrap();

        assert_eq!(
            locate("/nowhere/at/all/kubelogin", &[dir.path().to_path_buf()]),
            None
        );
    }
}
