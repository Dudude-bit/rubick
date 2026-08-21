//! Writing refreshed OIDC tokens back into the file they came from.
//!
//! `kubectl` does this, and skipping it is worse than not refreshing at all.
//! Dex hands out a new refresh token and invalidates the old one the moment it
//! is spent, so a refresh that is not written back leaves the file holding a
//! dead token — and breaks the `kubectl` the same person was using a minute
//! ago. That is why the caller settles the destination file *before* it asks
//! for a new token, and skips the refresh entirely when there is no single
//! answer.

use crate::error::{AuthError, Error, Result};
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// The files `$KUBECONFIG` names, in the order it names them.
///
/// A merged kubeconfig has no single home, which is the whole reason this
/// exists: the parsed document does not say which file any one user came from.
#[must_use]
pub fn kubeconfig_files(override_path: Option<PathBuf>) -> Vec<PathBuf> {
    if let Some(path) = override_path {
        return vec![path];
    }
    let separator = if cfg!(windows) { ';' } else { ':' };
    match std::env::var("KUBECONFIG") {
        Ok(value) if !value.is_empty() => value
            .split(separator)
            .filter(|entry| !entry.is_empty())
            .map(PathBuf::from)
            .collect(),
        _ => dirs::home_dir()
            .map(|home| vec![home.join(".kube").join("config")])
            .unwrap_or_default(),
    }
}

/// The single file that defines `user`, or `None` when that is not a single
/// answer.
///
/// Two files claiming one name is a real kubeconfig: the merge keeps the first
/// and Rubick has no business guessing which one somebody meant to edit.
#[must_use]
pub fn file_defining_user(files: &[PathBuf], user: &str) -> Option<PathBuf> {
    let mut found = None;
    for path in files {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&text) else {
            continue;
        };
        if user_entry(&doc, user).is_some() {
            if found.is_some() {
                return None;
            }
            found = Some(path.clone());
        }
    }
    found
}

fn user_entry<'a>(doc: &'a serde_yaml::Value, user: &str) -> Option<&'a serde_yaml::Value> {
    doc.get("users")?
        .as_sequence()?
        .iter()
        .find(|entry| entry.get("name").and_then(serde_yaml::Value::as_str) == Some(user))
}

/// Replace this user's `id-token` and `refresh-token`, leaving the rest of the
/// document as it was.
///
/// The edit goes through `serde_yaml::Value` rather than kube's own structs so
/// that keys the app does not model — and other users entirely — survive the
/// round trip untouched.
///
/// # Errors
///
/// If the file cannot be read or written, is not YAML, or does not carry an
/// `auth-provider` config for that user.
pub fn write_tokens(
    path: &Path,
    user: &str,
    id_token: &str,
    refresh_token: Option<&str>,
) -> Result<()> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        Error::Auth(AuthError::Kubeconfig(format!(
            "Cannot read {}: {e}",
            path.display()
        )))
    })?;
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|e| {
        Error::Auth(AuthError::Kubeconfig(format!(
            "Cannot parse {}: {e}",
            path.display()
        )))
    })?;

    let config = doc
        .get_mut("users")
        .and_then(serde_yaml::Value::as_sequence_mut)
        .and_then(|users| {
            users
                .iter_mut()
                .find(|entry| entry.get("name").and_then(serde_yaml::Value::as_str) == Some(user))
        })
        .and_then(|entry| entry.get_mut("user"))
        .and_then(|user| user.get_mut("auth-provider"))
        .and_then(|provider| provider.get_mut("config"))
        .and_then(serde_yaml::Value::as_mapping_mut)
        .ok_or_else(|| {
            Error::Auth(AuthError::Kubeconfig(format!(
                "No auth-provider config for user {user} in {}",
                path.display()
            )))
        })?;

    config.insert("id-token".into(), id_token.into());
    if let Some(token) = refresh_token {
        config.insert("refresh-token".into(), token.into());
    }

    let rendered = serde_yaml::to_string(&doc)
        .map_err(|e| Error::Auth(AuthError::Kubeconfig(format!("Cannot serialise: {e}"))))?;
    replace_file(path, &rendered)
}

/// Write through a temporary file in the same directory and rename over the
/// original, so a crash mid-write cannot leave somebody without a kubeconfig.
fn replace_file(path: &Path, contents: &str) -> Result<()> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| {
        Error::Auth(AuthError::Kubeconfig(format!(
            "Cannot write next to {}: {e}",
            path.display()
        )))
    })?;
    temp.write_all(contents.as_bytes())
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|e| Error::Auth(AuthError::Kubeconfig(format!("Cannot write: {e}"))))?;

    // A kubeconfig holds credentials; the replacement must not be the moment
    // it becomes world-readable, and a fresh temp file is 0600 on unix while
    // the original may be something else the owner chose.
    if let Ok(original) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(temp.path(), original.permissions());
    }

    temp.persist(path).map_err(|e| {
        Error::Auth(AuthError::Kubeconfig(format!(
            "Cannot replace {}: {e}",
            path.display()
        )))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r"apiVersion: v1
kind: Config
clusters:
- name: demo
  cluster:
    server: https://demo.example
contexts:
- name: demo
  context:
    cluster: demo
    user: alice
users:
- name: alice
  user:
    auth-provider:
      name: oidc
      config:
        client-id: kubernetes
        id-token: old-id
        idp-issuer-url: https://dex.example/dex
        refresh-token: old-refresh
- name: bob
  user:
    token: bob-stays-put
";

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write");
        path
    }

    #[test]
    fn replaces_both_tokens_for_the_named_user() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);

        write_tokens(&path, "alice", "new-id", Some("new-refresh")).expect("write");

        let after = std::fs::read_to_string(&path).expect("read");
        assert!(after.contains("new-id"), "{after}");
        assert!(after.contains("new-refresh"), "{after}");
        assert!(!after.contains("old-id"), "{after}");
        assert!(!after.contains("old-refresh"), "{after}");
    }

    /// The file belongs to its owner, not to us: a second user, the clusters,
    /// and the contexts have to come out the other side unchanged.
    #[test]
    fn leaves_everybody_else_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);

        write_tokens(&path, "alice", "new-id", Some("new-refresh")).expect("write");

        let after: serde_yaml::Value =
            serde_yaml::from_str(&std::fs::read_to_string(&path).expect("read")).expect("yaml");
        let before: serde_yaml::Value = serde_yaml::from_str(CONFIG).expect("yaml");
        assert_eq!(after.get("clusters"), before.get("clusters"));
        assert_eq!(after.get("contexts"), before.get("contexts"));
        assert_eq!(user_entry(&after, "bob"), user_entry(&before, "bob"));
        // The one key that was not part of the refresh stays as it was.
        let config = user_entry(&after, "alice")
            .and_then(|entry| entry.get("user"))
            .and_then(|user| user.get("auth-provider"))
            .and_then(|provider| provider.get("config"))
            .expect("config");
        assert_eq!(
            config
                .get("idp-issuer-url")
                .and_then(serde_yaml::Value::as_str),
            Some("https://dex.example/dex")
        );
    }

    /// A provider that hands back no new refresh token leaves the old one in
    /// place — overwriting it with nothing would lose the only way back.
    #[test]
    fn keeps_the_old_refresh_token_when_none_came_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);

        write_tokens(&path, "alice", "new-id", None).expect("write");

        let after = std::fs::read_to_string(&path).expect("read");
        assert!(after.contains("old-refresh"), "{after}");
        assert!(after.contains("new-id"), "{after}");
    }

    #[test]
    fn refuses_a_user_with_no_auth_provider() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);

        let result = write_tokens(&path, "bob", "new-id", None);

        assert!(result.is_err());
        let after = std::fs::read_to_string(&path).expect("read");
        assert_eq!(after, CONFIG, "a refusal must not touch the file");
    }

    #[test]
    fn finds_the_file_that_defines_the_user() {
        let dir = tempfile::tempdir().expect("tempdir");
        let other = write(dir.path(), "other", "apiVersion: v1\nusers: []\n");
        let mine = write(dir.path(), "config", CONFIG);

        let found = file_defining_user(&[other, mine.clone()], "alice");

        assert_eq!(found, Some(mine));
    }

    /// Two files claiming one name is a real kubeconfig. Guessing which one
    /// somebody meant to edit is how the wrong file gets rewritten, so the
    /// answer is "no single answer" and the caller declines to refresh.
    #[test]
    fn declines_when_two_files_claim_the_same_user() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = write(dir.path(), "first", CONFIG);
        let second = write(dir.path(), "second", CONFIG);

        assert_eq!(file_defining_user(&[first, second], "alice"), None);
    }

    #[test]
    fn declines_when_nobody_claims_the_user() {
        let dir = tempfile::tempdir().expect("tempdir");
        let only = write(dir.path(), "config", CONFIG);

        assert_eq!(file_defining_user(&[only], "carol"), None);
    }

    /// An unreadable or unparseable file must not stop the search: the user
    /// may well be defined in the next one along.
    #[test]
    fn steps_over_a_file_it_cannot_read() {
        let dir = tempfile::tempdir().expect("tempdir");
        let broken = write(dir.path(), "broken", "{{{not yaml");
        let missing = dir.path().join("absent");
        let mine = write(dir.path(), "config", CONFIG);

        let found = file_defining_user(&[broken, missing, mine.clone()], "alice");

        assert_eq!(found, Some(mine));
    }

    #[test]
    fn an_override_is_the_only_file_considered() {
        let path = PathBuf::from("/somewhere/explicit");
        assert_eq!(
            kubeconfig_files(Some(path.clone())),
            vec![path],
            "an explicit choice is not merged with anything"
        );
    }
}
