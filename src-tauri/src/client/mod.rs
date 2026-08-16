//! Kubernetes client management
//!
//! This module provides a client manager that handles multiple Kubernetes
//! cluster connections with support for different authentication methods.

use crate::error::{AuthError, Error, Result};
use dashmap::DashMap;
use kube::{
    config::{KubeConfigOptions, Kubeconfig},
    Client, Config,
};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

mod context;
pub use context::{ClusterContext, ContextAuth, ContextInfo};

/// Manages Kubernetes client connections for multiple clusters
pub struct K8sClientManager {
    /// Active clients by context name
    clients: DashMap<String, Arc<Client>>,

    /// Client configurations by context name
    configs: DashMap<String, Config>,

    /// Loaded kubeconfig
    kubeconfig: RwLock<Option<Kubeconfig>>,

    /// Default kubeconfig path
    kubeconfig_path: RwLock<Option<PathBuf>>,

    /// The file the loaded kubeconfig actually came from.
    ///
    /// Distinct from `kubeconfig_path`, which records an *override* and
    /// stays `None` for a default load. A screen reporting "where did this
    /// come from" needs the file either way, and overloading the override
    /// to carry it would quietly change what "no override" means.
    kubeconfig_source: RwLock<Option<PathBuf>>,

    /// When each context's credentials stop being accepted, where the
    /// credential plugin said so. Absent for a context that named no deadline
    /// or uses none — see `ClusterInfo::credentials_expire_at`.
    credential_deadlines: DashMap<String, chrono::DateTime<chrono::Utc>>,
}

impl K8sClientManager {
    /// Create a new client manager
    #[must_use]
    pub fn new() -> Self {
        Self {
            clients: DashMap::new(),
            configs: DashMap::new(),
            kubeconfig: RwLock::new(None),
            kubeconfig_path: RwLock::new(None),
            kubeconfig_source: RwLock::new(None),
            credential_deadlines: DashMap::new(),
        }
    }

    /// Load kubeconfig from default locations
    pub async fn load_kubeconfig(&self) -> Result<()> {
        let kubeconfig = Kubeconfig::read().map_err(|e| {
            Error::Auth(AuthError::Kubeconfig(format!(
                "Failed to read kubeconfig: {e}"
            )))
        })?;

        // Record which file that was. `Kubeconfig::read` does not say, and a
        // screen asking "where did this come from" cannot answer from the
        // parsed contents. This mirrors kube's own resolution: `KUBECONFIG`
        // when set, `~/.kube/config` otherwise. It goes to `kubeconfig_source`,
        // not to the override — a default load has no override.
        *self.kubeconfig_source.write().await = std::env::var_os("KUBECONFIG")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".kube").join("config")));

        *self.kubeconfig.write().await = Some(kubeconfig);
        Ok(())
    }

    /// The kubeconfig this manager holds, as it was parsed.
    ///
    /// Exposed for screens that report on the configuration rather than use
    /// it: re-reading the file would answer about a different moment, and
    /// possibly a different file.
    pub async fn kubeconfig(&self) -> Option<Kubeconfig> {
        self.kubeconfig.read().await.clone()
    }

    /// Load kubeconfig from an explicit path if `override_path` is
    /// Some, otherwise fall back to the default `$KUBECONFIG` / `~/.kube/config`
    /// search. The auth-flow callers route their `AppConfig.kubeconfig_path`
    /// override through here so we don't have to fork every callsite.
    pub async fn load_kubeconfig_resolved(&self, override_path: Option<PathBuf>) -> Result<()> {
        match override_path {
            Some(path) => self.load_kubeconfig_from_path(path).await,
            None => self.load_kubeconfig().await,
        }
    }

    /// Get a clone of the loaded kubeconfig
    pub async fn kubeconfig_clone(&self) -> Result<Kubeconfig> {
        let kubeconfig = self.kubeconfig.read().await;
        kubeconfig
            .as_ref()
            .cloned()
            .ok_or_else(|| Error::Config("Kubeconfig not loaded".to_string()))
    }

    /// Load kubeconfig from a specific path
    pub async fn load_kubeconfig_from_path(&self, path: PathBuf) -> Result<()> {
        // Resolve symlinks and `..` segments before opening the file.
        // Defuses both accidental misconfiguration and a class of
        // path-traversal attacks if the path ever flows from less-
        // trusted input. Returns a clear error if the file is missing.
        let path = canonicalize_kubeconfig_path(&path)?;

        let kubeconfig = Kubeconfig::read_from(&path).map_err(|e| {
            Error::Auth(AuthError::Kubeconfig(format!(
                "Failed to read kubeconfig from {path:?}: {e}"
            )))
        })?;

        *self.kubeconfig_path.write().await = Some(path.clone());
        *self.kubeconfig_source.write().await = Some(path);
        *self.kubeconfig.write().await = Some(kubeconfig);
        Ok(())
    }

    /// The kubeconfig this manager loaded, already canonicalised.
    ///
    /// `None` before the first load. Exposed so a diagnostic screen can name
    /// the file the app actually reads: re-deriving it from `KUBECONFIG` and
    /// `~/.kube/config` would let the screen name a different file whenever a
    /// symlink is involved, which is the disagreement such a screen exists to
    /// prevent.
    pub async fn kubeconfig_path(&self) -> Option<PathBuf> {
        self.kubeconfig_source.read().await.clone()
    }

    /// Get list of available contexts
    pub async fn list_contexts(&self) -> Result<Vec<ContextInfo>> {
        let kubeconfig = self.kubeconfig.read().await;
        let kubeconfig = kubeconfig
            .as_ref()
            .ok_or_else(|| Error::Config("Kubeconfig not loaded".to_string()))?;

        let current_context = kubeconfig.current_context.clone();

        let contexts = kubeconfig
            .contexts
            .iter()
            .map(|ctx| {
                let context = ctx.context.as_ref();
                let cluster = context.map(|c| c.cluster.clone()).unwrap_or_default();
                let user = context.and_then(|c| c.user.clone()).unwrap_or_default();
                ContextInfo {
                    name: ctx.name.clone(),
                    server: server_for_cluster(kubeconfig, &cluster),
                    exec_command: exec_command_for_user(kubeconfig, &user),
                    auth: auth_for_user(kubeconfig, &user),
                    cluster,
                    user,
                    namespace: context.and_then(|c| c.namespace.clone()),
                    is_current: Some(&ctx.name) == current_context.as_ref(),
                }
            })
            .collect();

        Ok(contexts)
    }

    /// Get current context name
    pub async fn get_current_context(&self) -> Result<Option<String>> {
        let kubeconfig = self.kubeconfig.read().await;
        let kubeconfig = kubeconfig
            .as_ref()
            .ok_or_else(|| Error::Config("Kubeconfig not loaded".to_string()))?;

        Ok(kubeconfig.current_context.clone())
    }

    /// Connect to a cluster by context name
    pub async fn connect(&self, context: &str) -> Result<Arc<Client>> {
        // Check if already connected
        if let Some(client) = self.clients.get(context) {
            return Ok(client.clone());
        }

        let config = self.create_config(context).await?;
        let client = Client::try_from(config.clone())
            .map_err(|e| Error::Connection(format!("Failed to create client: {e}")))?;

        let client = Arc::new(client);
        self.clients.insert(context.to_string(), client.clone());
        self.configs.insert(context.to_string(), config);

        tracing::info!("Connected to cluster: {}", context);
        Ok(client)
    }

    /// Connect to a cluster using a provided kubeconfig
    pub async fn connect_with_kubeconfig(
        &self,
        context: &str,
        kubeconfig: Kubeconfig,
    ) -> Result<Arc<Client>> {
        self.clients.remove(context);
        self.configs.remove(context);

        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            ..Default::default()
        };

        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| {
                Error::Config(format!(
                    "Failed to create config for context {context}: {e}"
                ))
            })?;
        let client = Client::try_from(config.clone())
            .map_err(|e| Error::Connection(format!("Failed to create client: {e}")))?;
        let client = Arc::new(client);
        self.clients.insert(context.to_string(), client.clone());
        self.configs.insert(context.to_string(), config);

        tracing::info!("Connected to cluster with prepared config: {}", context);
        Ok(client)
    }

    /// Create kube config for a context
    async fn create_config(&self, context: &str) -> Result<Config> {
        let kubeconfig = self.kubeconfig.read().await;
        let kubeconfig = kubeconfig
            .as_ref()
            .ok_or_else(|| Error::Config("Kubeconfig not loaded".to_string()))?;

        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            ..Default::default()
        };

        Config::from_custom_kubeconfig(kubeconfig.clone(), &options)
            .await
            .map_err(|e| {
                Error::Config(format!(
                    "Failed to create config for context {context}: {e}"
                ))
            })
    }

    /// Disconnect from a cluster
    pub fn disconnect(&self, context: &str) {
        self.clients.remove(context);
        self.configs.remove(context);
        tracing::info!("Disconnected from cluster: {}", context);
    }

    /// Drop every cached client and config. Used when the kubeconfig
    /// override is changed — the old clients were authenticated against
    /// the previous kubeconfig and would now point at the wrong (or
    /// non-existent) cluster.
    pub fn disconnect_all(&self) {
        self.clients.clear();
        self.configs.clear();
        tracing::info!("Disconnected from all clusters");
    }

    /// Get an existing client
    pub fn get_client(&self, context: &str) -> Option<Arc<Client>> {
        self.clients.get(context).map(|c| c.clone())
    }

    /// Get list of connected contexts
    pub fn connected_contexts(&self) -> Vec<String> {
        self.clients.iter().map(|r| r.key().clone()).collect()
    }

    /// Remember when this context's credentials stop working, where the
    /// plugin that issued them said so.
    pub fn set_credential_deadline(
        &self,
        context: &str,
        expires_at: Option<chrono::DateTime<chrono::Utc>>,
    ) {
        match expires_at {
            Some(at) => {
                self.credential_deadlines.insert(context.to_string(), at);
            }
            None => {
                // A reconnect that learned no deadline must not leave the
                // previous one standing: it belonged to a token that is gone.
                self.credential_deadlines.remove(context);
            }
        }
    }

    /// Test connection to a cluster
    pub async fn test_connection(&self, context: &str) -> Result<ClusterInfo> {
        let client = self.connect(context).await?;

        // Try to get server version
        let version = client
            .apiserver_version()
            .await
            .map_err(|e| Error::Connection(format!("Failed to get server version: {e}")))?;

        Ok(ClusterInfo {
            context: context.to_string(),
            server_version: format!("{}.{}", version.major, version.minor),
            platform: version.platform,
            git_version: version.git_version,
            credentials_expire_at: self
                .credential_deadlines
                .get(context)
                .map(|at| at.to_rfc3339()),
        })
    }
}

impl Default for K8sClientManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Information about a connected cluster
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ClusterInfo {
    pub context: String,
    pub server_version: String,
    pub platform: String,
    pub git_version: String,
    /// When the credentials this session was built with stop being accepted.
    ///
    /// `None` where the credential plugin named no deadline, or where the
    /// context does not use one at all — a client certificate does not expire
    /// on the hour. Nothing renews what the plugin gave: the `exec` block that
    /// could is stripped when the session is prepared, so this is the moment
    /// every request in the window starts failing, and a surface that has it
    /// can say so before that happens rather than after.
    pub credentials_expire_at: Option<String>,
}

/// The API server URL a context will dial, as the kubeconfig writes it.
fn server_for_cluster(kubeconfig: &Kubeconfig, cluster: &str) -> Option<String> {
    kubeconfig
        .clusters
        .iter()
        .find(|entry| entry.name == cluster)
        .and_then(|entry| entry.cluster.as_ref())
        .and_then(|cluster| cluster.server.clone())
}

/// The credential plugin a context runs, printed the way a shell would.
///
/// Arguments are joined with a single space and left unquoted: this is
/// read, never executed, and quoting it would put characters on screen
/// that the app is not going to send.
fn exec_command_for_user(kubeconfig: &Kubeconfig, user: &str) -> Option<String> {
    let exec = kubeconfig
        .auth_infos
        .iter()
        .find(|entry| entry.name == user)
        .and_then(|entry| entry.auth_info.as_ref())
        .and_then(|auth| auth.exec.as_ref())?;
    let command = exec.command.as_ref()?;
    Some(match exec.args.as_ref() {
        Some(args) if !args.is_empty() => format!("{command} {}", args.join(" ")),
        _ => command.clone(),
    })
}

/// Which credential a user entry holds, in the order kube-rs would try
/// them: a plugin or a provider takes over the whole exchange, so it
/// outranks any certificate or token sitting in the same entry.
///
/// A user entry that is absent, empty, or holds only a client *key* is
/// deliberately `Unrecognised`. The screen prints that as "cannot tell
/// from the file", which is true; naming a mechanism the app did not
/// find would put a confident wrong sentence on a debugging screen.
fn auth_for_user(kubeconfig: &Kubeconfig, user: &str) -> ContextAuth {
    let Some(auth) = kubeconfig
        .auth_infos
        .iter()
        .find(|entry| entry.name == user)
        .and_then(|entry| entry.auth_info.as_ref())
    else {
        return ContextAuth::Unrecognised;
    };

    if auth.exec.is_some() {
        return ContextAuth::Exec;
    }
    if let Some(provider) = auth.auth_provider.as_ref() {
        return ContextAuth::AuthProvider {
            name: provider.name.clone(),
        };
    }
    if auth.client_certificate_data.is_some() {
        return ContextAuth::ClientCertificate { source: None };
    }
    if let Some(path) = auth.client_certificate.as_ref() {
        return ContextAuth::ClientCertificate {
            source: Some(path.clone()),
        };
    }
    if auth.token.is_some() {
        return ContextAuth::Token { source: None };
    }
    if let Some(path) = auth.token_file.as_ref() {
        return ContextAuth::Token {
            source: Some(path.clone()),
        };
    }
    if auth.username.is_some() || auth.password.is_some() {
        return ContextAuth::Basic {
            username: auth.username.clone(),
        };
    }
    ContextAuth::Unrecognised
}

/// Resolve a kubeconfig path: expands `~`, follows symlinks, and
/// rejects paths whose target does not exist. Used as a chokepoint
/// before any `Kubeconfig::read_from(...)` so a stray `..` segment
/// or a stale symlink can't quietly load a different file than
/// the user thinks they're loading.
fn canonicalize_kubeconfig_path(path: &std::path::Path) -> Result<PathBuf> {
    let expanded: PathBuf = if let Some(stripped) = path
        .to_str()
        .and_then(|s| s.strip_prefix("~/"))
        .or_else(|| path.to_str().and_then(|s| s.strip_prefix("~")))
    {
        if let Some(home) = dirs::home_dir() {
            home.join(stripped)
        } else {
            path.to_path_buf()
        }
    } else {
        path.to_path_buf()
    };

    expanded.canonicalize().map_err(|e| {
        Error::Auth(AuthError::Kubeconfig(format!(
            "Cannot resolve kubeconfig path {expanded:?}: {e}"
        )))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[tokio::test]
    async fn test_client_manager_creation() {
        let manager = K8sClientManager::new();
        assert!(manager.connected_contexts().is_empty());
    }

    /// Every context row on the Clusters screen states how it
    /// authenticates. If this fails, either a shape the file describes
    /// perfectly well has started reading as "cannot tell", or — worse —
    /// an entry the app cannot classify has started claiming a mechanism.
    #[test]
    fn every_user_shape_is_classified_or_admitted() {
        let kubeconfig: Kubeconfig = serde_yaml::from_str(
            r#"
apiVersion: v1
kind: Config
users:
  - name: embedded-cert
    user:
      client-certificate-data: Zm9v
      client-key-data: YmFy
  - name: cert-on-disk
    user:
      client-certificate: /home/u/.minikube/client.crt
      client-key: /home/u/.minikube/client.key
  - name: inline-token
    user:
      token: abc123
  - name: token-on-disk
    user:
      tokenFile: /var/run/secrets/token
  - name: basic
    user:
      username: admin
      password: hunter2
  - name: legacy-oidc
    user:
      auth-provider:
        name: oidc
  - name: plugin
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubelogin
  - name: plugin-wins-over-cert
    user:
      client-certificate-data: Zm9v
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubelogin
  - name: empty
    user: {}
  - name: key-only
    user:
      client-key: /home/u/only.key
"#,
        )
        .expect("parse");

        let of = |user: &str| auth_for_user(&kubeconfig, user);
        assert_eq!(
            of("embedded-cert"),
            ContextAuth::ClientCertificate { source: None }
        );
        assert_eq!(
            of("cert-on-disk"),
            ContextAuth::ClientCertificate {
                source: Some("/home/u/.minikube/client.crt".to_string())
            }
        );
        assert_eq!(of("inline-token"), ContextAuth::Token { source: None });
        assert_eq!(
            of("token-on-disk"),
            ContextAuth::Token {
                source: Some("/var/run/secrets/token".to_string())
            }
        );
        assert_eq!(
            of("basic"),
            ContextAuth::Basic {
                username: Some("admin".to_string())
            }
        );
        assert_eq!(
            of("legacy-oidc"),
            ContextAuth::AuthProvider {
                name: "oidc".to_string()
            }
        );
        assert_eq!(of("plugin"), ContextAuth::Exec);
        assert_eq!(of("plugin-wins-over-cert"), ContextAuth::Exec);
        assert_eq!(of("empty"), ContextAuth::Unrecognised);
        assert_eq!(of("key-only"), ContextAuth::Unrecognised);
        assert_eq!(of("no-such-user"), ContextAuth::Unrecognised);
    }

    #[test]
    fn canonicalize_resolves_dot_segments() {
        // a/./b/../b → a/b after canonicalize, given a/b exists.
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real-kubeconfig");
        std::fs::File::create(&real)
            .unwrap()
            .write_all(b"apiVersion: v1\nkind: Config\n")
            .unwrap();

        let twisty = dir.path().join("./real-kubeconfig");

        let resolved = canonicalize_kubeconfig_path(&twisty).expect("canonicalize");
        // Compare against the real path's canonical form (handles macOS
        // /var → /private/var symlink).
        assert_eq!(
            resolved,
            real.canonicalize().unwrap(),
            "twisty path should resolve to the same canonical path"
        );
    }

    #[tokio::test]
    async fn load_kubeconfig_resolved_uses_override_path_when_some() {
        // The auth flow's "use my override" semantics: when
        // AppConfig.kubeconfig_path is Some, `load_kubeconfig_resolved`
        // must read that file (not $KUBECONFIG / ~/.kube/config).
        let dir = tempfile::tempdir().expect("tempdir");
        let override_path = dir.path().join("custom-kubeconfig.yaml");
        std::fs::write(
            &override_path,
            b"apiVersion: v1\nkind: Config\ncurrent-context: my-override-ctx\ncontexts:\n  - name: my-override-ctx\n    context:\n      cluster: c\n      user: u\nclusters: []\nusers: []\n",
        )
        .unwrap();

        let manager = K8sClientManager::new();
        manager
            .load_kubeconfig_resolved(Some(override_path.clone()))
            .await
            .expect("load with override");

        let loaded = manager
            .kubeconfig
            .read()
            .await
            .as_ref()
            .cloned()
            .expect("kubeconfig populated");
        assert_eq!(
            loaded.current_context.as_deref(),
            Some("my-override-ctx"),
            "override path should have been loaded, not the default kubeconfig"
        );
        // The override path is recorded so a later command (e.g. a
        // "show me which kubeconfig is active" UI affordance) can read it.
        let recorded = manager.kubeconfig_path.read().await.clone();
        assert_eq!(recorded, Some(override_path.canonicalize().unwrap()));
    }

    #[tokio::test]
    async fn load_kubeconfig_resolved_falls_back_to_default_when_none() {
        // None override must route through `load_kubeconfig()` which
        // uses Kubeconfig::read() — i.e. respects $KUBECONFIG or
        // ~/.kube/config. We can't easily assert WHICH file gets
        // loaded without polluting the test env, but we can pin that
        // the None path does NOT touch kubeconfig_path (no override
        // was requested, no path should be recorded).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake_kubeconfig = dir.path().join("test-default.yaml");
        std::fs::write(
            &fake_kubeconfig,
            b"apiVersion: v1\nkind: Config\ncurrent-context: from-env\ncontexts:\n  - name: from-env\n    context:\n      cluster: c\n      user: u\nclusters: []\nusers: []\n",
        )
        .unwrap();

        let manager = K8sClientManager::new();
        // SAFETY: tests in this crate run in-process; this is a
        // self-contained scope and we restore $KUBECONFIG before exit.
        let prior = std::env::var_os("KUBECONFIG");
        unsafe {
            std::env::set_var("KUBECONFIG", &fake_kubeconfig);
        }
        let result = manager.load_kubeconfig_resolved(None).await;
        unsafe {
            match prior {
                Some(v) => std::env::set_var("KUBECONFIG", v),
                None => std::env::remove_var("KUBECONFIG"),
            }
        }
        result.expect("load with default");

        let recorded = manager.kubeconfig_path.read().await.clone();
        assert!(
            recorded.is_none(),
            "load_kubeconfig_resolved(None) must NOT record an override path"
        );
    }

    #[test]
    fn canonicalize_rejects_missing_file() {
        let bogus = std::path::Path::new("/nonexistent/path/to/kubeconfig-xyz-12345");
        let err = canonicalize_kubeconfig_path(bogus).unwrap_err();
        match err {
            Error::Auth(AuthError::Kubeconfig(msg)) => {
                assert!(
                    msg.contains("Cannot resolve"),
                    "expected resolve error, got {msg:?}"
                );
            }
            other => panic!("expected Kubeconfig auth error, got {other:?}"),
        }
    }
}
