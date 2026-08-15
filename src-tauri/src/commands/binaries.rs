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

/// The directories a spawned plugin will actually be searched in.
///
/// The same list `locate_binaries` answers from, so a settings screen and
/// a connection cannot disagree about where a binary is.
pub(crate) fn search_directories() -> Vec<std::path::PathBuf> {
    let separator = PathResolver::separator();
    let user_path = crate::shell::get_user_path();
    let dirs: Vec<std::path::PathBuf> = user_path
        .split(separator)
        .filter(|entry| !entry.is_empty())
        .map(std::path::PathBuf::from)
        .collect();
    if dirs.is_empty() {
        PathResolver::fallback_directories()
    } else {
        dirs
    }
}

/// The plugin binary `kubectl <subcommand>` would look for, if the exec
/// block names one.
///
/// kubectl turns a subcommand into a file name by prefixing `kubectl-`
/// and replacing dashes with underscores, so `oidc-login` is served by
/// `kubectl-oidc_login`. Only the first non-flag argument is considered:
/// kubectl also tries longer joins for nested subcommands, and no
/// credential plugin in the wild uses one.
///
/// Returns `None` when the command is not kubectl or names no
/// subcommand — there is nothing to check in that case, and guessing
/// would refuse to run binaries that are perfectly present.
pub(crate) fn kubectl_plugin_binary(command: &str, args: &[String]) -> Option<String> {
    let file = std::path::Path::new(command).file_name()?.to_str()?;
    if file != "kubectl" && file != "kubectl.exe" {
        return None;
    }
    let sub = args.iter().find(|a| !a.starts_with('-'))?;
    if sub.is_empty() {
        return None;
    }
    Some(format!("kubectl-{}", sub.replace('-', "_")))
}

/// Where a binary would be found, using the connect-time search path.
pub(crate) fn locate_on_user_path(name: &str) -> Option<String> {
    locate(name, &search_directories())
}

/// Refuse an exec command whose kubectl plugin is not installed.
///
/// kubectl answers a missing plugin with `unknown command "oidc-login"
/// for "kubectl"`, and a terminal shows that verbatim. The text names
/// neither the file kubectl wanted — the underscore spelling is not
/// guessable — nor where it looked, so the reader learns that something
/// is wrong and nothing about what.
///
/// Ok for everything else, including plugins that are present and
/// commands that are not kubectl at all.
pub(crate) fn ensure_kubectl_plugin_present(command: &str, args: &[String]) -> Result<()> {
    // The context name is not known at this depth — the auth flow already
    // names the cluster in its own surroundings, and what was missing from
    // kubectl's message is the file and the search path, both of which the
    // finding carries.
    match crate::diagnostics::missing_plugin_finding("this context", command, args) {
        None => Ok(()),
        Some(finding) => Err(crate::error::Error::Plugin(
            crate::error::PluginError::NotFound(format!("{} — {}", finding.title, finding.detail)),
        )),
    }
}

/// Look up several binaries in one call.
///
/// Batched because the caller is a list: thirty contexts naming six
/// distinct plugins should be one round trip, not six.
#[tauri::command]
pub async fn locate_binaries(names: Vec<String>) -> Result<Vec<BinaryLocation>> {
    let search_dirs = search_directories();

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

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_kubectl_subcommand_names_the_plugin_file_kubectl_would_open() {
        // The dash-to-underscore swap is the whole rule, and the reason a
        // reader searching for "kubectl-oidc-login" finds nothing.
        assert_eq!(
            kubectl_plugin_binary("kubectl", &args(&["oidc-login", "get-token"])),
            Some("kubectl-oidc_login".to_string())
        );
    }

    #[test]
    fn an_absolute_kubectl_is_still_kubectl() {
        assert_eq!(
            kubectl_plugin_binary("/opt/homebrew/bin/kubectl", &args(&["oidc-login"])),
            Some("kubectl-oidc_login".to_string())
        );
    }

    #[test]
    fn flags_are_not_subcommands() {
        // `kubectl --help` asks kubectl itself, not a plugin. Treating the
        // first argument as a subcommand regardless would refuse to run a
        // command that is perfectly present.
        assert_eq!(kubectl_plugin_binary("kubectl", &args(&["--help"])), None);
        assert_eq!(
            kubectl_plugin_binary("kubectl", &args(&["--context=x", "oidc-login"])),
            Some("kubectl-oidc_login".to_string())
        );
    }

    #[test]
    fn anything_that_is_not_kubectl_has_no_plugin_to_miss() {
        // kubelogin and the cloud CLIs are whole binaries, not plugins;
        // checking for `kubelogin-get_token` would invent a missing file.
        assert_eq!(
            kubectl_plugin_binary("kubelogin", &args(&["get-token"])),
            None
        );
        assert_eq!(
            kubectl_plugin_binary("aws", &args(&["eks", "get-token"])),
            None
        );
        assert_eq!(kubectl_plugin_binary("kubectl", &[]), None);
    }

    #[test]
    fn a_command_with_no_plugin_to_miss_is_allowed_through() {
        // Nothing here may refuse a command that would have run. kubelogin
        // is a whole binary, and an absent one is the spawn's problem to
        // report, not this check's to guess at.
        assert!(ensure_kubectl_plugin_present("kubelogin", &args(&["get-token"])).is_ok());
        assert!(ensure_kubectl_plugin_present("kubectl", &args(&["--help"])).is_ok());
    }

    #[test]
    fn a_missing_plugin_is_named_along_with_where_it_was_sought() {
        let err = ensure_kubectl_plugin_present(
            "kubectl",
            &args(&["surely-no-such-credential-plugin", "get-token"]),
        )
        .expect_err("a plugin nobody has installed should be refused");

        let text = err.to_string();
        // The underscore spelling is the part a reader cannot guess, so it
        // has to appear verbatim; the searched directories are what turns
        // "not found" into something actionable.
        assert!(
            text.contains("kubectl-surely_no_such_credential_plugin"),
            "should name the file kubectl would open, got: {text}"
        );
        assert!(
            text.contains("Searched:"),
            "should say where it looked, got: {text}"
        );
    }

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
