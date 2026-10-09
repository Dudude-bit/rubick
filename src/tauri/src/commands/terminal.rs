//! Terminal/Exec commands

use crate::commands::helpers::ResourceContext;
use crate::error::Result;
use crate::state::AppState;
use crate::terminal::{SessionTarget, TerminalSessionInfo};
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

/// Every shell the backend holds open in a container: what Activity and the
/// status bar count, read from the one place that knows.
#[tauri::command]
#[must_use]
pub fn list_terminal_sessions(state: State<'_, AppState>) -> Vec<TerminalSessionInfo> {
    state.terminal_manager.list()
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
    let context = state.get_current_context().unwrap_or_default();

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

    let manager = state.client_manager.clone();
    let fresh_context = context.clone();
    let adapter = crate::terminal::PodExecAdapter::new(
        client,
        SessionTarget {
            context,
            namespace,
            pod,
            container: container_name,
        },
        shell.as_deref(),
    )
    .with_fresh_client(Box::new(move || {
        manager
            .get_client(&fresh_context)
            .map(|client| (*client).clone())
    }));

    let session_id = state.terminal_manager.create_session(Box::new(adapter))?;

    Ok(session_id)
}
