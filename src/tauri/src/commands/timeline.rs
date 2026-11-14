//! The timeline as the window asks for it: a page at a time, and what is
//! kept of it on this machine.

use tauri::State;

use crate::commands::settings::{off_main, with_config};
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::timeline::{Kept, TimelinePage, TimelineQuery};

/// One page of a cluster's timeline, from memory: the first ask for a
/// cluster reads what was kept of it from disk.
#[tauri::command]
pub async fn timeline_read(
    query: TimelineQuery,
    state: State<'_, AppState>,
) -> Result<TimelinePage> {
    let timelines = state.timeline.clone();
    timelines.start_writer();
    crate::client::clock::timed(
        &state.perf,
        "timelineRead",
        off_main(move || Ok(timelines.cluster(&query.context).page(&query))),
    )
    .await
}

/// How much is kept on disk, and whether keeping is on.
#[tauri::command]
pub async fn timeline_kept(state: State<'_, AppState>) -> Result<Kept> {
    let timelines = state.timeline.clone();
    off_main(move || Ok(timelines.kept())).await
}

/// Keeping between restarts on or off. Off stops writing; what is kept
/// stays until it is cleared.
#[tauri::command]
pub async fn timeline_set_keep(keep: bool, state: State<'_, AppState>) -> Result<()> {
    with_config(move |config| config.timeline.keep = keep).await?;
    state.timeline.set_keep(keep);
    Ok(())
}

/// Forgets every cluster's timeline, here and on disk.
#[tauri::command]
pub async fn timeline_clear(state: State<'_, AppState>) -> Result<()> {
    let timelines = state.timeline.clone();
    off_main(move || {
        timelines
            .clear()
            .map_err(|error| Error::Internal(format!("Could not clear the timeline: {error}")))
    })
    .await
}
