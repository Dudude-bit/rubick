//! Authentication commands

use crate::error::Result;
use crate::state::AppState;
use tauri::State;

/// Cancel an active auth session
#[tauri::command]
pub fn cancel_auth_session(session_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some(session) = state.remove_auth_session(&session_id) {
        let _ = session.cancel_tx.send(());
        state.emit(crate::state::AppEvent::AuthFlowCancelled {
            session_id,
            context: session.context,
            why: None,
        });
    }
    Ok(())
}
