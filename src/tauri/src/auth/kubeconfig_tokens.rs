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
    let named: Vec<PathBuf> = if let Some(path) = override_path {
        vec![path]
    } else {
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
    };

    // Through the loader's own resolution, for three separate reasons. A `~`
    // in a stored override is a path no `read_to_string` accepts. A symlinked
    // `~/.kube/config` has to become the file it points at, or the rename that
    // installs the replacement would put a regular file where the link was and
    // leave the real one holding the token just spent. And one file named
    // twice in `$KUBECONFIG` would otherwise read as two files claiming the
    // same user, which is the one shape that cancels the refresh.
    let mut resolved: Vec<PathBuf> = Vec::with_capacity(named.len());
    for path in named {
        if let Ok(real) = crate::client::canonicalize_kubeconfig_path(&path) {
            if !resolved.contains(&real) {
                resolved.push(real);
            }
        }
    }
    resolved
}

/// The single file that defines `user`, or `None` when that is not a single
/// answer.
///
/// Two files claiming one name is a real kubeconfig: the merge keeps the first
/// and Rubick has no business guessing which one somebody meant to edit.
#[must_use]
pub fn file_defining_user(files: &[PathBuf], user: &str) -> Option<PathBuf> {
    let mut found: Option<PathBuf> = None;
    let mut seen: Vec<PathBuf> = Vec::new();
    for path in files {
        // One file named twice is one file. Counting it twice would read as
        // two claimants, which is the single shape that cancels the refresh.
        let real =
            crate::client::canonicalize_kubeconfig_path(path).unwrap_or_else(|_| path.clone());
        if seen.contains(&real) {
            continue;
        }
        seen.push(real);
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

/// Whether this file could be replaced right now.
///
/// Asked *before* a refresh, never after: the token about to be spent is
/// single-use, so discovering at the end that there was nowhere to put the
/// replacement is discovering it one step too late. A file that cannot be
/// rewritten means no refresh at all, and the browser gets asked instead.
#[must_use]
pub fn can_replace(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if metadata.permissions().readonly() {
        return false;
    }
    // The rename lands in the directory, so that is what has to accept a new
    // file — a writable file inside a read-only directory is still a dead end.
    path.parent()
        .is_some_and(|directory| tempfile::NamedTempFile::new_in(directory).is_ok())
}

/// Where a user's two token lines live in a kubeconfig's text.
///
/// Line numbers rather than a parsed tree, because the file has to come back
/// out byte-identical apart from those two lines. A round trip through any
/// YAML library cannot promise that: it drops the owner's comments, and it
/// re-emits a quoted `"no"` bare — which `kubectl`, reading YAML 1.1 where
/// `no` is a boolean, then refuses to parse at all, taking every unrelated
/// context in the file down with it.
struct TokenLines {
    id_token: Option<usize>,
    refresh_token: Option<usize>,
    /// Column the keys of the `config` mapping start at, for a line that has
    /// to be added rather than replaced.
    indent: usize,
    /// Where such a line goes.
    insert_at: usize,
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// The value of `key` on this line, if the line is exactly `key: value`.
fn value_of<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let rest = line.trim_start().strip_prefix(key)?.strip_prefix(':')?;
    Some(rest.trim().trim_matches(['"', '\'']))
}

/// The half-open line range of the entry for `user` in the `users` sequence.
fn user_block(lines: &[&str], user: &str) -> Option<(usize, usize)> {
    let users = lines
        .iter()
        .position(|line| line.trim_end() == "users:" && indent_of(line) == 0)?;

    let dash = lines[users + 1..]
        .iter()
        .position(|line| line.trim_start().starts_with("- "))
        .map(|offset| users + 1 + offset)?;
    let dash_indent = indent_of(lines[dash]);

    // Every entry of the sequence, by the lines that open one.
    let mut starts = Vec::new();
    for (index, line) in lines.iter().enumerate().skip(dash) {
        if line.trim().is_empty() {
            continue;
        }
        let indent = indent_of(line);
        if indent == dash_indent && line.trim_start().starts_with("- ") {
            starts.push(index);
        } else if indent <= dash_indent {
            break; // a sibling of `users:` — the sequence is over
        }
    }

    for (position, &start) in starts.iter().enumerate() {
        let end = starts
            .get(position + 1)
            .copied()
            .unwrap_or_else(|| block_end(lines, start, dash_indent));
        let named = lines[start..end].iter().any(|line| {
            value_of(line, "- name") == Some(user) || value_of(line, "name") == Some(user)
        });
        if named {
            return Some((start, end));
        }
    }
    None
}

/// Where the block opened at `start` stops: the first later line indented no
/// deeper than the block itself.
fn block_end(lines: &[&str], start: usize, indent: usize) -> usize {
    lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| !line.trim().is_empty() && indent_of(line) <= indent)
        .map_or(lines.len(), |(index, _)| index)
}

/// The two token lines inside this user's `auth-provider` config.
fn token_lines(lines: &[&str], user: &str) -> Option<TokenLines> {
    let (start, end) = user_block(lines, user)?;
    let entry = &lines[start..end];

    let provider = entry
        .iter()
        .position(|line| line.trim_end().ends_with("auth-provider:"))?;
    let config = entry
        .iter()
        .enumerate()
        .skip(provider + 1)
        .find(|(_, line)| line.trim_end().ends_with("config:"))
        .map(|(index, _)| index)?;
    let config_indent = indent_of(entry[config]);

    let body_end = block_end(entry, config, config_indent);
    let indent = entry
        .get(config + 1)
        .filter(|line| !line.trim().is_empty())
        .map_or(config_indent + 2, |line| indent_of(line));

    let find = |key: &str| {
        entry[config + 1..body_end]
            .iter()
            .position(|line| value_of(line, key).is_some() && indent_of(line) == indent)
            .map(|offset| start + config + 1 + offset)
    };
    Some(TokenLines {
        id_token: find("id-token"),
        refresh_token: find("refresh-token"),
        indent,
        insert_at: start + body_end,
    })
}

/// Whether this file's text can be edited in place for `user`.
///
/// Asked before the refresh, next to `can_replace`, for the same reason: a
/// refresh token is single-use, so every way the write could fail has to be
/// ruled out before it is spent.
#[must_use]
pub fn can_write_tokens(path: &Path, user: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let lines: Vec<&str> = text.lines().collect();
    token_lines(&lines, user).is_some_and(|site| site.id_token.is_some())
}

/// Replace this user's `id-token` and `refresh-token` and change nothing else.
///
/// # Errors
///
/// If the file cannot be read or written, or those lines cannot be found.
pub fn write_tokens(
    path: &Path,
    user: &str,
    id_token: &str,
    refresh_token: Option<&str>,
) -> Result<()> {
    // Resolved here too, not only by the caller: renaming over a symlink
    // would leave a regular file where the link was and leave the file it
    // pointed at holding the token that has just been spent.
    let resolved =
        crate::client::canonicalize_kubeconfig_path(path).unwrap_or_else(|_| path.to_path_buf());
    let path = resolved.as_path();

    let text = std::fs::read_to_string(path).map_err(|e| {
        Error::Auth(AuthError::Kubeconfig(format!(
            "Cannot read {}: {e}",
            path.display()
        )))
    })?;
    let mut lines: Vec<String> = text.lines().map(ToString::to_string).collect();
    let borrowed: Vec<&str> = lines.iter().map(String::as_str).collect();
    let site = token_lines(&borrowed, user).ok_or_else(|| {
        Error::Auth(AuthError::Kubeconfig(format!(
            "No auth-provider config for user {user} in {}",
            path.display()
        )))
    })?;
    drop(borrowed);

    // Later line first, so replacing one cannot move the other.
    let mut edits: Vec<(usize, String)> = Vec::new();
    let pad = " ".repeat(site.indent);
    if let Some(line) = site.id_token {
        edits.push((line, format!("{pad}id-token: {id_token}")));
    } else {
        return Err(Error::Auth(AuthError::Kubeconfig(format!(
            "No id-token for user {user} in {}",
            path.display()
        ))));
    }
    if let Some(token) = refresh_token {
        match site.refresh_token {
            Some(line) => edits.push((line, format!("{pad}refresh-token: {token}"))),
            None => lines.insert(site.insert_at, format!("{pad}refresh-token: {token}")),
        }
    }
    for (line, replacement) in edits {
        lines[line] = replacement;
    }

    let mut rendered = lines.join("\n");
    if text.ends_with('\n') {
        rendered.push('\n');
    }
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

    /// The file belongs to its owner and exactly two lines in it are ours.
    /// Anything else that moves is a change nobody asked for — and one of them
    /// is fatal: `kubectl` reads YAML 1.1, where an unquoted `no` is a boolean,
    /// so re-emitting somebody else's `value: "no"` without its quotes makes
    /// the whole kubeconfig unparseable for every context in it.
    #[test]
    fn changes_only_the_two_lines_it_owns() {
        const OWNED: &str = r#"# A kubeconfig somebody wrote by hand.
apiVersion: v1
kind: Config
users:
- name: alice
  user:
    auth-provider:
      name: oidc
      config:
        client-id: kubernetes   # registered with Dex
        id-token: old-id
        refresh-token: old-refresh
- name: bob
  user:
    exec:
      command: kubelogin
      env:
      - name: KUBELOGIN_FORCE
        value: "no"
"#;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", OWNED);

        write_tokens(&path, "alice", "new-id", Some("new-refresh")).expect("write");

        let after = std::fs::read_to_string(&path).expect("read");
        let moved: Vec<(&str, &str)> = OWNED
            .lines()
            .zip(after.lines())
            .filter(|(before, now)| before != now)
            .collect();
        assert_eq!(
            moved,
            vec![
                ("        id-token: old-id", "        id-token: new-id"),
                (
                    "        refresh-token: old-refresh",
                    "        refresh-token: new-refresh"
                ),
            ],
            "\n--- after ---\n{after}"
        );
        assert_eq!(
            OWNED.lines().count(),
            after.lines().count(),
            "the file gained or lost lines"
        );
    }

    /// A config that has never been refreshed carries no `refresh-token` line
    /// at all; the first refresh has to add one rather than drop the token.
    #[test]
    fn adds_the_refresh_token_line_when_there_is_none() {
        const NEVER_REFRESHED: &str = r"apiVersion: v1
users:
- name: alice
  user:
    auth-provider:
      name: oidc
      config:
        client-id: kubernetes
        id-token: old-id
";
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", NEVER_REFRESHED);

        write_tokens(&path, "alice", "new-id", Some("new-refresh")).expect("write");

        let after = std::fs::read_to_string(&path).expect("read");
        assert!(
            after.contains("        refresh-token: new-refresh"),
            "{after}"
        );
        assert!(after.contains("        id-token: new-id"), "{after}");
        assert!(after.contains("        client-id: kubernetes"), "{after}");
    }

    /// The gate the caller leans on: it has to answer before a single-use
    /// token is spent, so a file it could not edit must answer no.
    #[test]
    fn says_up_front_whether_it_could_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);

        assert!(can_write_tokens(&path, "alice"));
        assert!(!can_write_tokens(&path, "bob"), "bob has no auth-provider");
        assert!(
            !can_write_tokens(&path, "carol"),
            "carol is not in the file"
        );
        assert!(!can_write_tokens(&dir.path().join("absent"), "alice"));
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
    fn a_writable_file_can_be_replaced() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);

        assert!(can_replace(&path));
    }

    #[test]
    fn a_file_that_is_not_there_cannot() {
        let dir = tempfile::tempdir().expect("tempdir");

        assert!(!can_replace(&dir.path().join("absent")));
    }

    /// The caller asks this before spending a single-use token, so a read-only
    /// file has to answer no — otherwise the refresh happens and the
    /// replacement has nowhere to go.
    #[cfg(unix)]
    #[test]
    fn a_read_only_file_cannot() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).expect("chmod");

        assert!(!can_replace(&path));
    }

    /// A writable file inside a directory that will not accept a new entry is
    /// still a dead end, because the replacement arrives by rename.
    #[cfg(unix)]
    #[test]
    fn nor_can_one_in_a_directory_that_takes_no_new_files() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500))
            .expect("chmod");

        let answer = can_replace(&path);

        // Put it back before the assert, or the tempdir cannot clean itself up.
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
            .expect("chmod");
        assert!(!answer);
    }

    #[test]
    fn an_override_is_the_only_file_considered() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);

        assert_eq!(
            kubeconfig_files(Some(path.clone())),
            vec![path.canonicalize().expect("canonicalize")],
            "an explicit choice is not merged with anything"
        );
    }

    /// A `~/.kube/config` that is a symlink into a dotfiles repo is an
    /// ordinary setup. The replacement arrives by rename, which would put a
    /// regular file where the link was and leave the real file holding the
    /// refresh token just spent — so the link has to be resolved first.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_kubeconfig_resolves_to_what_it_points_at() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = write(dir.path(), "real-config", CONFIG);
        let link = dir.path().join("config");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        assert_eq!(
            kubeconfig_files(Some(link)),
            vec![real.canonicalize().expect("canonicalize")]
        );
    }

    /// And the write must survive being handed the link directly.
    #[cfg(unix)]
    #[test]
    fn writing_through_a_link_keeps_the_link() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = write(dir.path(), "real-config", CONFIG);
        let link = dir.path().join("config");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        write_tokens(&link, "alice", "new-id", Some("new-refresh")).expect("write");

        assert!(
            std::fs::symlink_metadata(&link)
                .expect("stat")
                .file_type()
                .is_symlink(),
            "the link was replaced by a regular file"
        );
        assert!(
            std::fs::read_to_string(&real)
                .expect("read")
                .contains("new-id"),
            "the file the link points at did not get the new token"
        );
    }

    /// `$KUBECONFIG` naming one file twice is one file, not two claimants.
    #[test]
    fn one_file_named_twice_is_still_one_claimant() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config", CONFIG);

        assert_eq!(
            file_defining_user(&[path.clone(), path.clone()], "alice"),
            Some(path)
        );
    }
}
