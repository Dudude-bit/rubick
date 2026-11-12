//! Tauri commands for cross-cluster resource search.
//!
//! Three commands, mirroring the watch subsystem's lifecycle: start
//! (returns an id plus every cluster's initial state), release the
//! listener gate, cancel.
//!
//! The single-cluster path the palette used before this — one
//! `list_resources` per kind against the current context — is
//! untouched and still available; this is additive.

use crate::error::Result;
use crate::search::{SearchHandle, SearchManager, SearchRequest};
use crate::state::AppState;
use tauri::State;

/// Start a search across one, several, or all contexts.
///
/// Returns immediately with a `searchId` and one `SearchTarget` per
/// requested cluster; hits and terminal statuses arrive on the
/// `search-hits` / `search-status` event channels.
// `async` is load-bearing: the fan-out spawns, and Tauri only runs
// async commands on its Tokio runtime.
#[tauri::command]
pub async fn start_resource_search(
    request: SearchRequest,
    state: State<'_, AppState>,
) -> Result<SearchHandle> {
    SearchManager::start_from_request(&state, request).await
}

/// Signal that the frontend's `search-hits` / `search-status`
/// listeners are installed. The fan-out is gated on this so the first
/// cluster to answer cannot emit into the void.
#[tauri::command]
pub fn resource_search_subscribed(search_id: String, state: State<'_, AppState>) -> Result<()> {
    state.search_manager.mark_subscribed(&search_id)
}

/// Stop a search. Idempotent — cancelling a finished search is a no-op.
#[tauri::command]
pub fn cancel_resource_search(search_id: String, state: State<'_, AppState>) {
    state.search_manager.cancel(&search_id);
}
