//! The shape of every event the window listens for.

use crate::state::AppEvent;

/// Never called. The binding generator emits only the types a command
/// reaches, and this is how `AppEvent` reaches it: `src/lib/events.ts`
/// narrows the generated union to each channel's payload.
#[tauri::command]
pub async fn app_event_types() -> Option<AppEvent> {
    None
}
