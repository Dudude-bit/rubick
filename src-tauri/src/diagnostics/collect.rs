use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::commands::binaries::{kubectl_plugin_binary, locate_on_user_path, search_directories};
use crate::shell::ShellEnvReport;

/// One directory a spawned binary is looked for in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPathEntry {
    pub path: String,
    /// A directory named in the path that is not there is not an error, but
    /// it explains a search that came up empty.
    pub exists: bool,
}

impl SearchPathEntry {
    #[must_use]
    pub fn probe(path: &std::path::Path) -> Self {
        Self {
            exists: path.is_dir(),
            path: path.to_string_lossy().into_owned(),
        }
    }
}

/// A kubectl plugin some context needs, and whether it resolves.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    pub name: String,
    pub path: Option<String>,
    /// The contexts that would spawn it, so a reader knows what breaks.
    pub required_by: Vec<String>,
}

/// One tool the app spawns itself, and what it answered.
///
/// Distinct from `PluginStatus`: this list is fixed and compiled in, that one
/// is whatever the kubeconfig names, and only this one is ever executed — a
/// settings pane that ran every `command` a context declared would run
/// arbitrary programs because somebody opened a tab.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    /// The file that would run. `None` means nothing was found on the search
    /// path above, which is the first thing to check when it should be there.
    pub path: Option<String>,
    pub version: Option<String>,
}

/// How one context authenticates, and whether that can work.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticContext {
    pub context: String,
    /// `exec`, `token`, `client-certificate`, `auth-provider` or `none`.
    pub method: String,
    /// The exec command, when the method is `exec`.
    pub command: Option<String>,
    /// Where that command resolves, when it does.
    pub command_path: Option<String>,
}

/// The kubeconfig itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigInfo {
    pub path: String,
    /// `None` when it parsed; the parse error when it did not.
    pub parse_error: Option<String>,
    pub context_count: usize,
}

/// The installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationInfo {
    pub version: String,
    pub os: String,
    pub config_path: Option<String>,
    /// Where logs go. Saying "stdout" is worth more than leaving it blank:
    /// stdout is nowhere at all under a Dock launch, which is why nobody
    /// finds them.
    pub log_destination: String,
}

impl InstallationInfo {
    #[must_use]
    pub fn collect() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            config_path: dirs::config_dir().map(|d| {
                d.join("k8s-gui")
                    .join("config.toml")
                    .to_string_lossy()
                    .into_owned()
            }),
            log_destination: "stdout (not captured when launched from the Dock)".to_string(),
        }
    }
}

/// Everything the panel shows, in one read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    /// Whether the login shell's environment was adopted at startup. When it
    /// was not, the search path below is a guess, and this says so first.
    pub shell: ShellEnvReport,
    /// Whether the search path below was built from the shell's answer.
    ///
    /// The fact, not the rule. `ShellEnvReport::answered()` decides it once: a
    /// second `outcome === "imported" || ...` on the frontend is one rule with
    /// two implementations across the IPC boundary, and the outcome added the
    /// same day had to be excluded from both by hand. The next one would be
    /// excluded from one.
    pub search_path_is_real: bool,
    pub search_path: Vec<SearchPathEntry>,
    pub tools: Vec<ToolStatus>,
    pub plugins: Vec<PluginStatus>,
    pub contexts: Vec<DiagnosticContext>,
    pub kubeconfig: Option<KubeconfigInfo>,
    pub app: InstallationInfo,
    pub findings: Vec<super::Finding>,
}

/// The exec block a named user declares, if any.
fn exec_for<'a>(raw: &'a Kubeconfig, user_name: &str) -> Option<&'a kube::config::ExecConfig> {
    raw.auth_infos
        .iter()
        .find(|n| n.name == user_name)
        .and_then(|n| n.auth_info.as_ref())
        .and_then(|a| a.exec.as_ref())
}

/// The user a context names.
fn user_for(raw: &Kubeconfig, context: &str) -> Option<String> {
    raw.contexts
        .iter()
        .find(|n| n.name == context)
        .and_then(|n| n.context.as_ref())
        .and_then(|c| c.user.clone())
}

/// How each context authenticates.
#[must_use]
pub fn contexts_from(raw: &Kubeconfig) -> Vec<DiagnosticContext> {
    raw.contexts
        .iter()
        .map(|named| {
            let user = named
                .context
                .as_ref()
                .and_then(|c| c.user.clone())
                .unwrap_or_default();
            let auth = raw
                .auth_infos
                .iter()
                .find(|n| n.name == user)
                .and_then(|n| n.auth_info.as_ref());

            let (method, command) = match auth {
                Some(a) if a.exec.is_some() => {
                    let cmd = a.exec.as_ref().and_then(|e| e.command.clone());
                    ("exec".to_string(), cmd)
                }
                Some(a) if a.token.is_some() => ("token".to_string(), None),
                Some(a) if a.client_certificate.is_some() => {
                    ("client-certificate".to_string(), None)
                }
                Some(a) if a.auth_provider.is_some() => ("auth-provider".to_string(), None),
                _ => ("none".to_string(), None),
            };

            DiagnosticContext {
                context: named.name.clone(),
                command_path: command.as_deref().and_then(locate_on_user_path),
                method,
                command,
            }
        })
        .collect()
}

/// Every kubectl plugin the contexts need, with who needs it.
///
/// Keyed in name order: two reads of an unchanged machine must produce the
/// same list in the same order, or the panel appears to change when nothing
/// did.
#[must_use]
pub fn plugins_from(contexts: &[DiagnosticContext], raw: &Kubeconfig) -> Vec<PluginStatus> {
    let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for ctx in contexts {
        let Some(user) = user_for(raw, &ctx.context) else {
            continue;
        };
        let Some(exec) = exec_for(raw, &user) else {
            continue;
        };
        let (Some(command), Some(args)) = (exec.command.as_deref(), exec.args.as_ref()) else {
            continue;
        };
        if let Some(plugin) = kubectl_plugin_binary(command, args) {
            by_name.entry(plugin).or_default().push(ctx.context.clone());
        }
    }

    by_name
        .into_iter()
        .map(|(name, required_by)| PluginStatus {
            path: locate_on_user_path(&name),
            name,
            required_by,
        })
        .collect()
}

/// What one tool's answer amounts to.
///
/// `check_availability` answers `available: false` for two different
/// machines — one where the binary is absent, one where it is right there and
/// would not run (wrong architecture, no execute bit, a wrapper that exits
/// non-zero). `try_path` returns `None` for both, so the two arrive here
/// indistinguishable — and the message, "not found in any search location", is untrue
/// of the second. That difference is most of why somebody opens this pane:
/// one says install it, the other says reinstalling the same file will not
/// fix it. So the caller locates the file, which this module can do and
/// `check_availability` cannot, and this decides what the pair means.
fn tool_status(
    name: &str,
    found: crate::cli::CliAvailability,
    located: Option<String>,
) -> ToolStatus {
    if found.available {
        return ToolStatus {
            name: name.to_string(),
            path: found.path,
            version: found.version,
        };
    }
    // No error string. `check_availability` composes one in Rust — the wrong
    // place for a sentence a reader sees — and it could only ever have survived
    // where `path` is `None`, which is not the state the pane colours. The three
    // states are `path` and `version`: both, path alone, neither.
    ToolStatus {
        name: name.to_string(),
        path: located,
        version: None,
    }
}

/// What each known tool resolved to, asked concurrently.
///
/// Fresh managers rather than the app's cached ones: those resolve once and
/// hold it, which is right for a hot path and wrong for a panel whose job is
/// to say what is true now — somebody installing the plugin the findings
/// named wants the next read to notice. Concurrent because each answer costs
/// a process launch with a five-second ceiling, and six in a row is a pane
/// that takes half a minute to say everything is fine.
async fn tools_status() -> Vec<ToolStatus> {
    use crate::cli::cloud::{AzTool, GcloudTool, GkeAuthPluginTool, KubeloginTool};
    use crate::cli::helm::HelmTool;
    use crate::cli::kubectl::KubectlTool;
    use crate::cli::CliToolManager;

    async fn ask<T: crate::cli::CliTool>(name: &str, tool: T) -> ToolStatus {
        let binary = tool.binary_name();
        let found = CliToolManager::new(tool).check_availability().await;
        let located = (!found.available)
            .then(|| locate_on_user_path(binary))
            .flatten();
        tool_status(name, found, located)
    }

    let (kubectl, helm, gcloud, gke, az, kubelogin) = tokio::join!(
        // The configured override, not a bare default: a reader who pointed
        // the app at their own kubectl needs the panel to report that one.
        ask("kubectl", KubectlTool::with_default_config()),
        ask("helm", HelmTool::with_default_config()),
        ask("gcloud", GcloudTool::new()),
        ask("gke-gcloud-auth-plugin", GkeAuthPluginTool::new()),
        ask("az", AzTool::new()),
        ask("kubelogin", KubeloginTool::new()),
    );
    vec![kubectl, helm, gcloud, gke, az, kubelogin]
}

/// Read the environment.
///
/// Best-effort per block: a kubeconfig that will not parse becomes a finding
/// and leaves every other block answering. A page that empties itself because
/// one file is malformed would hide the very facts somebody came for.
pub async fn collect(client: &crate::client::K8sClientManager) -> Diagnostics {
    // `None` before `main` has run the import — in a test binary, or in a
    // build that stopped calling it. Its own state, not `NotAsked`: that one
    // means Windows had nothing to ask and the path is right, which would
    // suppress every caveat below on a machine where the path is a guess.
    let shell = crate::shell::env_report()
        .cloned()
        .unwrap_or(ShellEnvReport::NotRecorded);
    let search_path = search_directories()
        .into_iter()
        .map(|path| SearchPathEntry::probe(&path))
        .collect();
    let app = InstallationInfo::collect();
    let search_path_is_real = shell.answered();
    let tools = tools_status().await;

    // The parsed config the app is already living on, not a fresh read of
    // the file. A second read would answer about a different moment, and
    // this panel exists because two answers about one machine is the bug.
    let Some(raw) = client.kubeconfig().await else {
        // Nothing parsed. Two different reasons land here and they must not
        // read the same: a file that would not parse is a problem with an
        // address and a fix, while no file at all is just an app nobody has
        // pointed at a cluster yet. Collapsing them answers "no kubeconfig
        // loaded" to somebody looking at a kubeconfig.
        let (kubeconfig, mut findings) = match client.kubeconfig_error().await {
            Some(why) => {
                let path = client.kubeconfig_path().await.map_or_else(
                    || "unknown".to_string(),
                    |p| p.to_string_lossy().into_owned(),
                );
                (
                    Some(KubeconfigInfo {
                        path: path.clone(),
                        parse_error: Some(why.clone()),
                        context_count: 0,
                    }),
                    vec![super::unreadable_kubeconfig_finding(&path, &why)],
                )
            }
            None => (None, Vec::new()),
        };
        findings.extend(super::shell_env_finding(&shell));
        return Diagnostics {
            shell,
            search_path_is_real,
            search_path,
            tools,
            plugins: Vec::new(),
            contexts: Vec::new(),
            kubeconfig,
            app,
            findings,
        };
    };

    let path = client.kubeconfig_path().await.map_or_else(
        || "unknown — loaded before the path was recorded".to_string(),
        |p| p.to_string_lossy().into_owned(),
    );

    let contexts = contexts_from(&raw);
    let plugins = plugins_from(&contexts, &raw);

    let mut findings: Vec<super::Finding> = contexts
        .iter()
        .filter_map(|ctx| {
            let user = user_for(&raw, &ctx.context)?;
            let exec = exec_for(&raw, &user)?;
            super::missing_plugin_finding(
                &ctx.context,
                exec.command.as_deref()?,
                exec.args.as_ref()?,
            )
        })
        .collect();
    findings.extend(super::shell_env_finding(&shell));
    findings.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            .then_with(|| a.subject.cmp(&b.subject))
    });

    Diagnostics {
        shell,
        search_path_is_real,
        search_path,
        tools,
        plugins,
        contexts,
        kubeconfig: Some(KubeconfigInfo {
            path,
            parse_error: None,
            context_count: raw.contexts.len(),
        }),
        app,
        findings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absent(name: &str) -> crate::cli::CliAvailability {
        crate::cli::CliAvailability {
            available: false,
            version: None,
            error: Some(format!("{name} not found in any search location")),
            path: None,
            searched_paths: vec!["/opt/homebrew/bin".into()],
        }
    }

    /// A tool that answered is reported by what it answered.
    #[test]
    fn a_tool_that_ran_reports_its_path_and_version() {
        let found = crate::cli::CliAvailability {
            available: true,
            version: Some("v1.31.0".into()),
            error: None,
            path: Some("/opt/homebrew/bin/kubectl".into()),
            searched_paths: Vec::new(),
        };

        let out = tool_status("kubectl", found, None);
        assert_eq!(out.path.as_deref(), Some("/opt/homebrew/bin/kubectl"));
        assert_eq!(out.version.as_deref(), Some("v1.31.0"));
    }

    /// Would break if the two ways of being unavailable were merged again.
    ///
    /// The third state the panel exists for: the file is right there and
    /// would not run. `check_availability` reports that as "not found in any
    /// search location", so a reader told it would go and install what they
    /// already have.
    #[test]
    fn a_tool_that_is_present_and_would_not_run_says_where_it_is() {
        let out = tool_status(
            "helm",
            absent("helm"),
            Some("/opt/homebrew/bin/helm".to_string()),
        );

        assert_eq!(out.path.as_deref(), Some("/opt/homebrew/bin/helm"));
        assert_eq!(out.version, None);
    }

    /// The ordinary absence: no path and no version, which is what tells it
    /// apart from the case above. There is no third field to carry a reason —
    /// the sentence `check_availability` composes for this is English written
    /// in Rust, and nothing renders it.
    #[test]
    fn a_tool_that_is_nowhere_says_so_with_both_fields_empty() {
        let out = tool_status("az", absent("az"), None);

        assert_eq!(out.path, None);
        assert_eq!(out.version, None);
    }

    fn kubeconfig_with_exec() -> Kubeconfig {
        serde_yaml::from_str(
            r#"
apiVersion: v1
kind: Config
clusters:
  - name: c1
    cluster:
      server: https://api.example.internal
contexts:
  - name: orders-stage
    context:
      cluster: c1
      user: u1
current-context: orders-stage
users:
  - name: u1
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubectl
        args: ["oidc-login", "get-token"]
"#,
        )
        .expect("fixture parses")
    }

    #[test]
    fn a_search_path_entry_says_whether_the_directory_is_really_there() {
        let dir = tempfile::tempdir().expect("tempdir");
        let present = SearchPathEntry::probe(dir.path());
        assert!(present.exists, "a directory that exists should say so");

        let absent = SearchPathEntry::probe(&dir.path().join("nowhere"));
        assert!(
            !absent.exists,
            "a directory in the path that does not exist is worth showing as such"
        );
    }

    #[test]
    fn the_application_block_answers_without_a_cluster() {
        let app = InstallationInfo::collect();
        assert!(!app.version.is_empty(), "the app knows its own version");
        assert!(!app.os.is_empty(), "and the platform it runs on");
    }

    #[test]
    fn a_context_reports_how_it_authenticates() {
        let contexts = contexts_from(&kubeconfig_with_exec());
        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[0].context, "orders-stage");
        assert_eq!(contexts[0].method, "exec");
        assert_eq!(contexts[0].command.as_deref(), Some("kubectl"));
    }

    #[test]
    fn a_plugin_lists_every_context_that_would_spawn_it() {
        let raw = kubeconfig_with_exec();
        let plugins = plugins_from(&contexts_from(&raw), &raw);
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].name, "kubectl-oidc_login");
        assert_eq!(plugins[0].required_by, vec!["orders-stage".to_string()]);
    }

    #[tokio::test]
    async fn a_manager_that_has_loaded_nothing_still_answers() {
        // The blocks that do not depend on a cluster are exactly the ones
        // somebody debugging a failed connection needs.
        let client = crate::client::K8sClientManager::new();
        let d = collect(&client).await;

        assert!(
            d.kubeconfig.is_none(),
            "nothing was loaded, so nothing is named"
        );
        assert!(!d.app.version.is_empty());

        // Exactly one finding, and it is the one that says nobody recorded
        // whether the shell was asked — because in a test binary nobody did.
        // Asserting an empty list instead passes while an un-run import is
        // drawn as `NotAsked` ("Windows, nothing to ask", `answered()` true,
        // every caveat below suppressed), so a `main()` that stopped calling
        // the import stays green while the panel tells a Mac about PowerShell.
        assert!(
            matches!(d.shell, ShellEnvReport::NotRecorded),
            "an import that never ran is its own state: {:?}",
            d.shell
        );
        assert_eq!(d.findings.len(), 1, "{:?}", d.findings);
        // And the fact the frontend reads follows the rule, rather than the
        // frontend deciding it again: an import that never ran did not build
        // the search path, so every absence below it is a guess.
        assert!(!d.search_path_is_real);
        assert_eq!(d.search_path_is_real, d.shell.answered());
        assert!(
            d.findings[0].about_shell,
            "the finding is marked as being about the shell, and the report it
             is about is the one on `Diagnostics`"
        );
    }

    /// The case this panel was built for, and the one it used to be silent
    /// about: a kubeconfig that exists and will not parse. Silence here is
    /// worse than nothing, because the reader is looking at the file while
    /// the app tells them there is no file.
    #[tokio::test]
    async fn a_kubeconfig_that_will_not_parse_says_so() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config");
        std::fs::write(&path, "clusters: [ this is not\n  a kubeconfig\n").expect("write");

        let client = crate::client::K8sClientManager::new();
        let failed = client.load_kubeconfig_from_path(path.clone()).await;
        assert!(failed.is_err(), "the fixture has to actually fail to parse");

        let d = collect(&client).await;

        let kc = d
            .kubeconfig
            .expect("a file that exists is named even when it will not parse");
        assert!(
            kc.parse_error.is_some(),
            "the reason is the whole point; without it the panel says nothing \
             the reader did not already know"
        );
        assert_eq!(kc.context_count, 0);

        let finding = d
            .findings
            .iter()
            .find(|f| f.title == "Kubeconfig could not be read")
            .expect("the doc comment on `collect` promises this finding");
        assert_eq!(finding.severity, super::super::Severity::Blocking);
        assert!(
            finding.subject.as_deref().is_some_and(|s| !s.is_empty()),
            "a finding nobody can locate is not actionable"
        );
    }

    /// The third state has to stay a third state: never having loaded is not
    /// a broken file, and drawing them the same way puts a blocking finding
    /// on an app that is merely new.
    #[tokio::test]
    async fn never_having_loaded_is_not_a_broken_file() {
        let client = crate::client::K8sClientManager::new();
        assert!(client.kubeconfig_error().await.is_none());

        let d = collect(&client).await;
        assert!(d.kubeconfig.is_none());
        assert!(
            !d.findings
                .iter()
                .any(|f| f.title == "Kubeconfig could not be read"),
            "nothing was ever read, so nothing failed to read"
        );
    }
}
