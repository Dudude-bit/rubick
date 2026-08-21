//! CLI-driven helm commands — anything that mutates cluster state
//! (install / upgrade / rollback / uninstall / repo CRUD / search)
//! shells out to the helm binary instead of the API server.

use crate::cli::CliAvailability;
use crate::error::{Error, PluginError, Result};
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

/// Helper to execute helm CLI commands
async fn exec_helm_cli(args: &[&str], timeout_secs: u64) -> Result<String> {
    exec_helm_cli_with_context(args, timeout_secs, None).await
}

/// Helper to execute helm CLI commands with optional kube context
async fn exec_helm_cli_with_context(
    args: &[&str],
    timeout_secs: u64,
    context: Option<&str>,
) -> Result<String> {
    let manager = helm_manager().await;
    let mut cmd = manager.command().await?;
    cmd = cmd
        .args(args.iter().map(std::string::ToString::to_string))
        .timeout(Duration::from_secs(timeout_secs));

    if let Some(ctx) = context {
        cmd = cmd.arg("--kube-context").arg(ctx);
    }

    cmd.run_success()
        .await
        .map_err(|e| Error::Plugin(PluginError::ExecutionFailed(e.to_string())))
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

    let context = state.get_current_context();
    let revision_str = revision.to_string();

    exec_helm_cli_with_context(
        &["rollback", &name, &revision_str, "-n", &namespace],
        120,
        context.as_deref(),
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

    let context = state.get_current_context();

    exec_helm_cli_with_context(
        &["uninstall", &name, "-n", &namespace],
        120,
        context.as_deref(),
    )
    .await
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
    context: Option<&str>,
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
    let result = exec_helm_cli_with_context(&args_refs, 300, context).await;

    // Clean up temp file
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
    let context = state.get_current_context();
    helm_install_or_upgrade("install", &options, context.as_deref()).await
}

/// Upgrade a Helm release
#[tauri::command]
pub async fn helm_upgrade(
    options: HelmInstallOptions,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_dns_subdomain(&options.release_name)?;
    crate::validation::validate_namespace(&options.namespace)?;
    let context = state.get_current_context();
    helm_install_or_upgrade("upgrade", &options, context.as_deref()).await
}
