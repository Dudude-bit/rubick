//! The performance recording switch and its counters, for Diagnostics.

use crate::error::Result;
use crate::state::perf::PerfSnapshot;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn perf_set_recording(recording: bool, state: State<'_, AppState>) -> Result<()> {
    state.perf.set_recording(recording);
    Ok(())
}

#[tauri::command]
pub async fn perf_counters(state: State<'_, AppState>) -> Result<PerfSnapshot> {
    Ok(state.perf.snapshot())
}
