//! CLI-driven helm commands — anything that mutates cluster state
//! (install / upgrade / rollback / uninstall / repo CRUD / search)
//! shells out to the helm binary instead of the API server.

use crate::cli::CliAvailability;
use crate::client::CliTarget;
use crate::error::{Error, PluginError, Result};
use crate::shell::ShellCommand;
use crate::state::AppState;
use serde::Deserialize;
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

async fn run(cmd: ShellCommand) -> Result<String> {
    cmd.run_success()
        .await
        .map_err(|e| Error::Plugin(PluginError::ExecutionFailed(e.to_string())))
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

    // Handle values - write to temp file if provided
    let temp_file = if let Some(values) = &options.values {
        if values.trim().is_empty() {
            None
        } else {
            let temp_dir = std::env::temp_dir();
            let temp_path = temp_dir.join(format!("helm-values-{}.yaml", uuid::Uuid::new_v4()));
            std::fs::write(&temp_path, values).map_err(|e| {
                Error::Plugin(PluginError::ExecutionFailed(format!(
                    "Failed to write values file: {e}"
                )))
            })?;
            args.push("-f".to_string());
            args.push(temp_path.to_string_lossy().to_string());
            Some(temp_path)
        }
    } else {
        None
    };

    let args_refs: Vec<&str> = args.iter().map(std::string::String::as_str).collect();
    let result = exec_helm_on_cluster(state, &args_refs, 300).await;

    if let Some(path) = temp_file {
        let _ = std::fs::remove_file(path);
    }

    result
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
