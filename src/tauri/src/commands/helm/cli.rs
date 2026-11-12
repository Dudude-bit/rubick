//! CLI-driven helm commands — anything that mutates cluster state
//! (install / upgrade / rollback / uninstall / repo CRUD / search)
//! shells out to the helm binary instead of the API server.

use crate::cli::CliAvailability;
use crate::client::CliTarget;
use crate::error::{Error, PluginError, Result};
use crate::shell::ShellCommand;
use crate::state::AppState;
use serde::Deserialize;
use std::io::Write;
use std::time::Duration;
use tauri::State;

use super::manager::helm_manager;
use super::types::{HelmChartSearchResult, HelmInstallOptions, HelmRepository};

/// Check if Helm CLI is available
///
/// This command checks whether helm is available on the system,
/// returns version information, and lists all paths that were searched.
#[tauri::command]
pub async fn check_helm_availability() -> Result<CliAvailability> {
    let manager = helm_manager().await;
    Ok(manager.check_availability().await)
}

/// Run helm on its own files: repositories and the chart search.
async fn exec_helm_cli(args: &[&str], timeout_secs: u64) -> Result<String> {
    run(helm(args, timeout_secs).await?).await
}

/// Run helm against the cluster the app is showing.
async fn exec_helm_on_cluster(
    state: &AppState,
    args: &[&str],
    timeout_secs: u64,
) -> Result<String> {
    let target = current_target(state).await?;
    run(aimed(helm(args, timeout_secs).await?, &target)).await
}

async fn helm(args: &[&str], timeout_secs: u64) -> Result<ShellCommand> {
    let manager = helm_manager().await;
    Ok(manager
        .command()
        .await?
        .args(args)
        .timeout(Duration::from_secs(timeout_secs)))
}

/// What helm said, as it may leave this process: an install prints the
/// chart's notes, and notes are judged like the ones the release keeps.
async fn run(cmd: ShellCommand) -> Result<String> {
    let mut said = match cmd.run_success().await {
        Ok(said) => Ok(said),
        Err(e) => Err(e.to_string()),
    };
    let (Ok(text) | Err(text)) = &mut said;
    crate::resources::withhold_text(text);
    said.map_err(|e| Error::Plugin(PluginError::ExecutionFailed(e)))
}

/// The cluster a mutation is for. No current context is an error, never a
/// helm left to pick its own.
async fn current_target(state: &AppState) -> Result<CliTarget> {
    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;
    state.client_manager.cli_target(&context).await
}

/// The context by name, in the files the app read it from.
fn aimed(cmd: ShellCommand, target: &CliTarget) -> ShellCommand {
    cmd.arg("--kube-context")
        .arg(&target.context)
        .env("KUBECONFIG", &target.kubeconfig)
}

/// Rollback Helm release to a previous revision
#[tauri::command]
pub async fn helm_rollback(
    name: String,
    namespace: String,
    revision: i32,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_dns_subdomain(&name)?;
    crate::validation::validate_namespace(&namespace)?;

    let revision_str = revision.to_string();

    exec_helm_on_cluster(
        &state,
        &["rollback", &name, &revision_str, "-n", &namespace],
        120,
    )
    .await
}

/// Uninstall Helm release
#[tauri::command]
pub async fn helm_uninstall(
    name: String,
    namespace: String,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_dns_subdomain(&name)?;
    crate::validation::validate_namespace(&namespace)?;

    exec_helm_on_cluster(&state, &["uninstall", &name, "-n", &namespace], 120).await
}

/// List Helm repositories
#[tauri::command]
pub async fn list_helm_repos() -> Result<Vec<HelmRepository>> {
    let output = exec_helm_cli(&["repo", "list", "-o", "json"], 30).await?;

    let repos: Vec<HelmRepository> = serde_json::from_str(&output).map_err(|e| {
        Error::Plugin(PluginError::ExecutionFailed(format!(
            "Failed to parse repos: {e}"
        )))
    })?;

    Ok(repos)
}

/// Add Helm repository
#[tauri::command]
pub async fn add_helm_repo(name: String, url: String) -> Result<String> {
    exec_helm_cli(&["repo", "add", &name, &url], 60).await
}

/// Remove Helm repository
#[tauri::command]
pub async fn remove_helm_repo(name: String) -> Result<String> {
    exec_helm_cli(&["repo", "remove", &name], 30).await
}

/// Update Helm repositories
#[tauri::command]
pub async fn update_helm_repos() -> Result<String> {
    exec_helm_cli(&["repo", "update"], 120).await
}

/// One row of `helm search repo -o json`.
#[derive(Deserialize)]
struct SearchResult {
    name: String,
    version: String,
    app_version: String,
    description: String,
}

/// Search for Helm charts in repositories
#[tauri::command]
pub async fn helm_search_charts(keyword: String) -> Result<Vec<HelmChartSearchResult>> {
    // Search in all repos
    let output = exec_helm_cli(&["search", "repo", &keyword, "-o", "json"], 30).await?;

    let results: Vec<SearchResult> = serde_json::from_str(&output).map_err(|e| {
        Error::Plugin(PluginError::ExecutionFailed(format!(
            "Failed to parse search results: {e}"
        )))
    })?;

    Ok(results
        .into_iter()
        .map(|r| HelmChartSearchResult {
            name: r.name,
            version: r.version,
            app_version: r.app_version,
            description: r.description,
        })
        .collect())
}

/// Helper for install/upgrade operations
async fn helm_install_or_upgrade(
    command: &str,
    options: &HelmInstallOptions,
    state: &AppState,
) -> Result<String> {
    let values = values_to_send(options)?;
    let mut args = vec![
        command.to_string(),
        options.release_name.clone(),
        options.chart.clone(),
        "-n".to_string(),
        options.namespace.clone(),
    ];

    if let Some(version) = &options.version {
        args.push("--version".to_string());
        args.push(version.clone());
    }

    // Only for install
    if command == "install" && options.create_namespace {
        args.push("--create-namespace".to_string());
    }

    if options.wait {
        args.push("--wait".to_string());
    }

    if let Some(timeout) = &options.timeout {
        args.push("--timeout".to_string());
        args.push(timeout.clone());
    }

    let file = values.map(values_file).transpose().map_err(|e| {
        Error::Plugin(PluginError::ExecutionFailed(format!(
            "Failed to write values file: {e}"
        )))
    })?;
    if let Some(file) = &file {
        args.push("-f".to_string());
        args.push(file.to_string_lossy().to_string());
    }

    let args_refs: Vec<&str> = args.iter().map(std::string::String::as_str).collect();
    exec_helm_on_cluster(state, &args_refs, 300).await
}

/// The values helm is to be handed, or none to leave it the ones the release
/// has. Values copied off the Values tab hold the placeholder where the app
/// withheld a private key, and helm would store it as the key: those are
/// refused, by the text, so no way of writing YAML carries it through.
fn values_to_send(options: &HelmInstallOptions) -> Result<Option<&str>> {
    let values = options.values.as_deref().filter(|v| !v.trim().is_empty());
    match values {
        Some(text) if text.contains(crate::resources::WITHHELD_MARKER) => {
            Err(Error::WithheldValue {
                keys: crate::resources::placeholders_in(text),
            })
        }
        values => Ok(values),
    }
}

/// The values as a file for `-f`: readable by this user only, since values
/// carry passwords, and removed when dropped.
fn values_file(values: &str) -> std::io::Result<tempfile::TempPath> {
    let mut file = tempfile::Builder::new()
        .prefix("helm-values-")
        .suffix(".yaml")
        .tempfile()?;
    file.write_all(values.as_bytes())?;
    Ok(file.into_temp_path())
}

/// Install a Helm chart
#[tauri::command]
pub async fn helm_install(
    options: HelmInstallOptions,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_dns_subdomain(&options.release_name)?;
    crate::validation::validate_namespace(&options.namespace)?;
    helm_install_or_upgrade("install", &options, &state).await
}

/// Upgrade a Helm release
#[tauri::command]
pub async fn helm_upgrade(
    options: HelmInstallOptions,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_dns_subdomain(&options.release_name)?;
    crate::validation::validate_namespace(&options.namespace)?;
    helm_install_or_upgrade("upgrade", &options, &state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Given the context name alone, helm resolves it in its own kubeconfig.
    /// With a pinned file that is another file, and an uninstall lands on
    /// whichever cluster wears the same name there.
    #[tokio::test]
    async fn a_cluster_command_resolves_its_context_in_the_files_the_app_read() {
        let target = CliTarget {
            context: "kubernetes-admin@kubernetes".to_string(),
            kubeconfig: "/clusters/prod.yaml".into(),
        };
        let stand_in = ShellCommand::new("sh").args([
            "-c",
            r#"printf '%s %s %s' "$KUBECONFIG" "$1" "$2""#,
            "helm",
        ]);

        let seen = run(aimed(stand_in, &target)).await.expect("runs");

        assert_eq!(
            seen,
            "/clusters/prod.yaml --kube-context kubernetes-admin@kubernetes"
        );
    }

    fn options(values: Option<&str>) -> HelmInstallOptions {
        HelmInstallOptions {
            release_name: "web".to_string(),
            chart: "repo/web".to_string(),
            namespace: "shop".to_string(),
            version: None,
            values: values.map(str::to_string),
            create_namespace: false,
            wait: false,
            timeout: None,
        }
    }

    /// The Values tab shows the placeholder where it withheld a private
    /// key, with Copy. Pasted into Upgrade or Install and sent, helm stored
    /// the placeholder as the key. Fails if such values get as far as a
    /// file, however the YAML is written, or if clean values do not.
    #[test]
    fn values_that_still_hold_the_placeholder_are_never_handed_to_helm() {
        use crate::resources::WITHHELD_MARKER;
        let refused = |values: &str| match values_to_send(&options(Some(values))) {
            Err(Error::WithheldValue { keys }) => keys,
            other => panic!("sent: {other:?}"),
        };

        let copied = format!("password: hunter2\ntls:\n  privateKey: '{WITHHELD_MARKER}'\n");
        assert_eq!(refused(&copied), ["tls.privateKey"]);
        let block = format!("privateKey: |-\n  {WITHHELD_MARKER}\n");
        assert_eq!(refused(&block), ["privateKey"]);
        // Text helm's parser may take and this one does not is still refused.
        assert!(refused(&format!("a: b: c\nkey: {WITHHELD_MARKER}\n")).is_empty());

        let clean = options(Some("password: hunter2\n"));
        let sent = values_to_send(&clean).expect("sent");
        assert_eq!(sent, Some("password: hunter2\n"));
        // No values at all: helm keeps the ones the release has.
        assert_eq!(values_to_send(&options(None)).expect("sent"), None);
        assert_eq!(values_to_send(&options(Some("  \n"))).expect("sent"), None);
    }

    /// The refusal comes before a file is written or a cluster is looked
    /// for: with no cluster connected, values that hold the placeholder are
    /// refused for what they hold, and clean ones for the missing cluster.
    #[tokio::test]
    async fn an_upgrade_and_an_install_refuse_the_placeholder_before_anything_else() {
        let state = AppState::new().expect("state");
        let copied = format!("privateKey: '{}'\n", crate::resources::WITHHELD_MARKER);

        for command in ["upgrade", "install"] {
            let refused = helm_install_or_upgrade(command, &options(Some(&copied)), &state).await;
            assert!(
                matches!(&refused, Err(Error::WithheldValue { keys }) if keys == &["privateKey"]),
                "{command}: {refused:?}"
            );
            let clean = helm_install_or_upgrade(command, &options(Some("a: b\n")), &state).await;
            assert!(
                matches!(clean, Err(Error::Internal(_))),
                "{command}: {clean:?}"
            );
        }
    }

    /// `helm install` prints the chart's notes, and the command hands back
    /// what helm printed. Fails if notes that print a key cross to the
    /// frontend, or if helm's ordinary words do not.
    #[tokio::test]
    async fn what_helm_prints_is_handed_back_without_a_private_key() {
        const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");
        let prints =
            |text: &str| ShellCommand::new("sh").args(["-c", r#"printf '%s' "$1""#, "helm", text]);

        let notes = format!("NAME: web\nNOTES:\nYour key:\n{KEY}");
        let said = run(prints(&notes)).await.expect("runs");
        assert_eq!(said, crate::resources::WITHHELD_MARKER);

        let said = run(prints("Release \"web\" has been upgraded.")).await;
        assert_eq!(said.expect("runs"), "Release \"web\" has been upgraded.");
    }

    /// Values carry passwords. Written with the default mode they sat in a
    /// shared temp directory, readable by every local user for the whole run.
    #[test]
    fn the_values_file_is_its_owners_alone_and_gone_after_the_run() {
        let file = values_file("password: hunter2\n").expect("written");
        let path = file.to_path_buf();

        assert_eq!(
            std::fs::read_to_string(&path).expect("readable"),
            "password: hunter2\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("there")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        drop(file);
        assert!(!path.exists());
    }

    /// Without a current context the command used to run with no
    /// `--kube-context` at all, on whatever cluster helm itself points at.
    #[tokio::test]
    async fn a_cluster_command_with_no_cluster_connected_is_refused() {
        let state = AppState::new().expect("state");

        let refused = current_target(&state).await.expect_err("no cluster");

        assert!(
            refused
                .to_string()
                .contains(crate::error::messages::NO_CLUSTER),
            "{refused}"
        );
    }
}
