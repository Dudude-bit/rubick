//! The kubeconfig, looked at again while the app runs. A connected
//! context's client is built once from its entry; `kind create` and every
//! cloud CLI rewrite that entry by writing a new file and renaming it over
//! the old, so the files are stated by inode as well as size and time, and
//! an entry is compared by what it says: a token a CLI refreshed in place is
//! not another cluster.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use kube::config::Kubeconfig;
use tokio::sync::broadcast;

use super::K8sClientManager;
use crate::state::AppEvent;

const LOOK_EVERY: Duration = Duration::from_secs(2);

/// What a `kubectl`-style auth provider rewrites in place on every refresh.
const REFRESHED: &[&str] = &[
    "access-token",
    "expiry",
    "expires-in",
    "expires-on",
    "id-token",
    "refresh-token",
];

/// One file as it stands on disk: its inode where the platform has one, its
/// size and its modification time.
type Stamp = Vec<(PathBuf, Option<(u64, u64, SystemTime)>)>;

#[cfg(unix)]
fn inode(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.ino()
}

#[cfg(not(unix))]
fn inode(_: &std::fs::Metadata) -> u64 {
    0
}

fn stamp(files: &[PathBuf]) -> Stamp {
    files
        .iter()
        .map(|path| {
            let held = std::fs::metadata(path).ok().map(|meta| {
                let at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                (inode(&meta), meta.len(), at)
            });
            (path.clone(), held)
        })
        .collect()
}

/// Each context's entry as a client is built from it, its cluster and its
/// user, with the tokens a CLI refreshes in place left out.
fn prints(kubeconfig: &Kubeconfig) -> HashMap<String, u64> {
    let value = |item: Option<serde_json::Value>| item.unwrap_or(serde_json::Value::Null);
    kubeconfig
        .contexts
        .iter()
        .map(|named| {
            let context = named.context.as_ref();
            let cluster = context.and_then(|c| {
                kubeconfig
                    .clusters
                    .iter()
                    .find(|cluster| cluster.name == c.cluster)
                    .and_then(|cluster| serde_json::to_value(&cluster.cluster).ok())
            });
            let mut user = value(context.and_then(|c| c.user.as_ref()).and_then(|name| {
                kubeconfig
                    .auth_infos
                    .iter()
                    .find(|user| user.name == *name)
                    .and_then(|user| serde_json::to_value(&user.auth_info).ok())
            }));
            if let Some(config) = user
                .pointer_mut("/auth-provider/config")
                .and_then(serde_json::Value::as_object_mut)
            {
                config.retain(|key, _| !REFRESHED.contains(&key.as_str()));
            }
            let mut hasher = DefaultHasher::new();
            format!("{}\n{user}", value(cluster)).hash(&mut hasher);
            (named.name.clone(), hasher.finish())
        })
        .collect()
}

/// What the files and entries were when last looked at.
#[derive(Default)]
pub(crate) struct Seen {
    stamp: Stamp,
    prints: HashMap<String, u64>,
}

impl K8sClientManager {
    /// The files the loaded kubeconfig was read from.
    async fn loaded_files(&self) -> Vec<PathBuf> {
        let loaded = self.loaded.read().await;
        if loaded.files.is_empty() {
            loaded.source.clone().into_iter().collect()
        } else {
            loaded.files.clone()
        }
    }

    async fn loaded_prints(&self) -> HashMap<String, u64> {
        self.loaded
            .read()
            .await
            .kubeconfig
            .as_ref()
            .map(prints)
            .unwrap_or_default()
    }

    pub(crate) async fn seen(&self) -> Seen {
        Seen {
            stamp: stamp(&self.loaded_files().await),
            prints: self.loaded_prints().await,
        }
    }
}

/// Looks once. `None` where nothing on disk moved, or where the files read
/// are other files, which is a pinned path changed in Settings and has a
/// way of its own; else the contexts whose entry changed or went.
pub(crate) async fn look(
    manager: &K8sClientManager,
    seen: &mut Seen,
    overrides: Vec<PathBuf>,
) -> Option<Vec<String>> {
    look_then(manager, seen, overrides, || {}).await
}

/// [`look`], with `read` run once the files are read: where a test writes
/// the file again in between.
async fn look_then(
    manager: &K8sClientManager,
    seen: &mut Seen,
    overrides: Vec<PathBuf>,
    read: impl FnOnce(),
) -> Option<Vec<String>> {
    // Stated before the read and kept: a file written again after it reads
    // as moved at the next look, not as the one read.
    let now = stamp(&manager.loaded_files().await);
    if now == seen.stamp {
        return None;
    }
    let same_files = now
        .iter()
        .map(|(path, _)| path)
        .eq(seen.stamp.iter().map(|(path, _)| path));
    if !same_files {
        *seen = manager.seen().await;
        return None;
    }
    // A file caught half written does not parse: looked at again next time.
    manager.load_kubeconfig_resolved(overrides).await.ok()?;
    read();
    let prints = manager.loaded_prints().await;
    let changed = seen
        .prints
        .iter()
        .filter(|(context, print)| prints.get(*context) != Some(*print))
        .map(|(context, _)| context.clone())
        .collect();
    *seen = Seen { stamp: now, prints };
    Some(changed)
}

/// Looks every two seconds for as long as the app runs, and tells the
/// window which contexts' entries changed: a connected one is connected
/// again, through the same path a reconnect takes.
pub async fn run(manager: Arc<K8sClientManager>, events: broadcast::Sender<AppEvent>) {
    let mut seen = manager.seen().await;
    loop {
        tokio::time::sleep(LOOK_EVERY).await;
        let overrides = crate::commands::cluster::read_kubeconfig_overrides();
        if let Some(changed) = look(&manager, &mut seen, overrides).await {
            if !changed.is_empty() {
                let _ = events.send(AppEvent::KubeconfigChanged { changed });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(server: &str, token: &str) -> String {
        format!(
            "apiVersion: v1\nkind: Config\ncurrent-context: kind-x\n\
             clusters: [{{name: kind-x, cluster: {{server: '{server}'}}}}, {{name: other, cluster: {{server: 'https://10.0.0.1'}}}}]\n\
             users: [{{name: kind-x, user: {{auth-provider: {{name: oidc, config: {{client-id: app, id-token: '{token}'}}}}}}}}]\n\
             contexts: [{{name: kind-x, context: {{cluster: kind-x, user: kind-x}}}}, {{name: other, context: {{cluster: other, user: kind-x}}}}]\n"
        )
    }

    /// Writes `text` beside `path` and renames it over, as kind and kubectl do.
    fn replace(path: &std::path::Path, text: &str) {
        let beside = path.with_extension("tmp");
        std::fs::write(&beside, text).expect("write");
        std::fs::rename(&beside, path).expect("rename");
    }

    /// A kubeconfig replaced by rename with another server for a context is
    /// seen, and names that context alone. Fails if a replaced file goes
    /// unseen, which left the app dialling a deleted cluster until restart.
    #[tokio::test]
    async fn a_file_replaced_by_rename_names_the_context_whose_entry_moved() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("config");
        let token = || format!("t{}", "1".repeat(12));
        std::fs::write(&path, config("https://127.0.0.1:41001", &token())).expect("write");
        let manager = K8sClientManager::new();
        manager
            .load_kubeconfig_from_path(path.clone())
            .await
            .expect("load");
        let mut seen = manager.seen().await;
        let pinned = vec![path.clone()];
        assert_eq!(look(&manager, &mut seen, pinned.clone()).await, None);

        replace(&path, &config("https://127.0.0.1:41002", &token()));
        assert_eq!(
            look(&manager, &mut seen, pinned.clone()).await,
            Some(vec!["kind-x".to_string()])
        );
        assert_eq!(look(&manager, &mut seen, pinned).await, None);
    }

    /// A file written again while the last version was being read is looked
    /// at again. Fails if the stamp kept is the newer file's beside the older
    /// file's entries, which left the client on the old entry for good.
    #[tokio::test]
    async fn a_file_written_again_during_a_read_is_read_again() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("config");
        let token = format!("t{}", "1".repeat(12));
        std::fs::write(&path, config("https://127.0.0.1:41001", &token)).expect("write");
        let manager = K8sClientManager::new();
        manager
            .load_kubeconfig_from_path(path.clone())
            .await
            .expect("load");
        let mut seen = manager.seen().await;
        replace(&path, &config("https://127.0.0.1:41002", &token));
        let again = config("https://127.0.0.1:41003", &token);
        let looked = look_then(&manager, &mut seen, vec![path.clone()], || {
            replace(&path, &again);
        })
        .await;
        assert!(looked.is_some_and(|looked| looked == vec!["kind-x".to_string()]));
        assert_eq!(
            look(&manager, &mut seen, vec![path]).await,
            Some(vec!["kind-x".to_string()])
        );
    }

    /// A token an auth provider refreshed in place changes the file and no
    /// entry. Fails if every refresh reconnected the window.
    #[tokio::test]
    async fn a_token_refreshed_in_place_is_no_entry_changed() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("config");
        std::fs::write(
            &path,
            config("https://127.0.0.1:41001", &format!("t{}", "1".repeat(12))),
        )
        .expect("write");
        let manager = K8sClientManager::new();
        manager
            .load_kubeconfig_from_path(path.clone())
            .await
            .expect("load");
        let mut seen = manager.seen().await;

        replace(
            &path,
            &config("https://127.0.0.1:41001", &format!("t{}", "2".repeat(12))),
        );
        assert_eq!(
            look(&manager, &mut seen, vec![path]).await,
            Some(Vec::new())
        );
    }
}
