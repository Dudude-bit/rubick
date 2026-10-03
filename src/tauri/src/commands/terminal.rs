//! Terminal/Exec commands

use crate::commands::helpers::ResourceContext;
use crate::error::Result;
use crate::state::AppState;
use tauri::State;

/// Send input to terminal session
#[tauri::command]
pub async fn terminal_input(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<()> {
    state.terminal_manager.send_input(&session_id, &data).await
}

/// Resize terminal session
#[tauri::command]
pub async fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<()> {
    state
        .terminal_manager
        .resize_session(&session_id, cols, rows)
        .await
}

/// Close terminal session
#[tauri::command]
pub fn close_terminal(session_id: String, state: State<'_, AppState>) -> Result<()> {
    state.terminal_manager.close_session(&session_id)
}

/// Signal that the frontend has registered its `terminal-output` and
/// `terminal-closed` listeners and is ready to receive events. The
/// backend I/O loop blocks on this signal before reading from the
/// adapter, so early output bytes don't get emitted into the void.
/// Idempotent — calling twice is a no-op. Errors only on unknown
/// session IDs so a malicious caller cannot release arbitrary sessions.
#[tauri::command]
pub fn terminal_subscribed(session_id: String, state: State<'_, AppState>) -> Result<()> {
    state.terminal_manager.mark_subscribed(&session_id)
}

/// Open a shell in a pod
#[tauri::command]
pub async fn open_pod_shell(
    namespace: String,
    pod: String,
    container: Option<String>,
    shell: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    let ctx = ResourceContext::for_command(&state, Some(namespace.clone()))?;
    let client = ctx.client.clone();

    // Get container name if not provided
    let container_name = if let Some(c) = container {
        c
    } else {
        let pod_obj: k8s_openapi::api::core::v1::Pod = ctx.namespaced_api().get(&pod).await?;
        pod_obj
            .spec
            .and_then(|s| s.containers.first().map(|c| c.name.clone()))
            .unwrap_or_default()
    };

    // Create adapter and session
    // Use provided shell or smart shell detection
    let shell_command = if let Some(shell) = shell {
        vec![shell]
    } else {
        // Smart shell detection: try fish, then zsh, then bash, then sh
        // We use /bin/sh as the entrypoint to execute the detection logic
        let smart_command = "if command -v fish >/dev/null 2>&1; then exec fish; elif command -v zsh >/dev/null 2>&1; then exec zsh; elif command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";
        vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            smart_command.to_string(),
        ]
    };

    let adapter =
        crate::terminal::PodExecAdapter::new(client, namespace, pod, container_name, shell_command);

    let session_id = state
        .terminal_manager
        .create_session(Box::new(adapter))
        .await?;

    Ok(session_id)
}
