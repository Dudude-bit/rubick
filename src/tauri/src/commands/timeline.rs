//! The timeline as the window asks for it: a page at a time, and what is
//! kept of it on this machine.

use tauri::State;

use crate::commands::settings::{off_main, with_config};
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::timeline::follow::{ask, Control};
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

/// Whether `follow` found another cluster under the name than the one its
/// timeline was kept for, which then starts over.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Following {
    pub another_cluster: bool,
}

/// Records the cluster on screen: the followed kinds and its events, on the
/// shared watches, read across the cluster, and in the window's namespaces
/// `scope` where the cluster refuses a kind across it. Asked again with the
/// same context, it moves those namespaces only.
#[tauri::command]
pub async fn timeline_follow(
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Following> {
    let scope = crate::commands::helpers::scope_of(scope)?;
    let timelines = state.timeline.clone();
    timelines.start_writer();
    // Reconnected while kube-system was read, perhaps to another cluster under
    // the name: what the old client read says nothing of the cluster held
    // now, so it is read again through the new one. A client that keeps
    // changing leaves the cluster unchecked rather than misnamed.
    let mut tries = 0;
    let (here, another_cluster) = loop {
        let here = state.here()?;
        let cluster = cluster_of(&timelines, &here.context).await?;
        let read = kube::Api::<k8s_openapi::api::core::v1::Namespace>::all((*here.client).clone())
            .get("kube-system")
            .await;
        tries += 1;
        if let Some(another) = identify(&state, &here.context, &here.client, &cluster, read) {
            break (here, another);
        }
        if tries == 3 {
            cluster.unsettled();
            break (state.here()?, false);
        }
    };
    let context = here.context.clone();
    if timelines.tell(&context, Control::Rescope(scope.clone())) {
        return Ok(Following { another_cluster });
    }
    let subscription = state.feeds.subscribe(&here, ask(scope)).await?;
    timelines.follow(context, subscription);
    Ok(Following { another_cluster })
}

async fn cluster_of(
    timelines: &std::sync::Arc<crate::timeline::Timelines>,
    context: &str,
) -> Result<std::sync::Arc<crate::timeline::ClusterTimeline>> {
    let timelines = timelines.clone();
    let context = context.to_string();
    off_main(move || Ok(timelines.cluster(&context))).await
}

/// What `read` says of which cluster `cluster` is, applied only while
/// `client` is still the one held for `context`: checked and applied under
/// the lock a connect installs its client under, with nothing awaited
/// between, so a reconnect cannot land in the gap. `None` where it was
/// replaced: the read says nothing of the cluster held now. A reader who may
/// not read kube-system cannot tell, and nothing is dropped.
pub(crate) fn identify(
    state: &AppState,
    context: &str,
    client: &std::sync::Arc<kube::Client>,
    cluster: &crate::timeline::ClusterTimeline,
    read: kube::Result<k8s_openapi::api::core::v1::Namespace>,
) -> Option<bool> {
    let _lifecycle = state.cluster_lifecycle.lock();
    if !state.still_holds(context, client) {
        return None;
    }
    Some(match read {
        Ok(namespace) => namespace
            .metadata
            .uid
            .is_some_and(|identity| cluster.seen_cluster(identity)),
        Err(error) => {
            cluster.not_identified(Error::from(error).said());
            false
        }
    })
}

/// A timeline is on screen: the ownership index is kept reading, and what it
/// reads by name of the kinds the followed watches do not read is told to
/// the recorder. Said again every 30 s while one is; the index idles out on
/// its own once nothing asks.
#[tauri::command]
pub async fn timeline_hold(scope: Option<Vec<String>>, state: State<'_, AppState>) -> Result<bool> {
    let scope = crate::commands::helpers::scope_of(scope)?;
    let here = state.here()?;
    let index = state.ownership.ensure_on(&here, scope).await?;
    if !index.listened() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        if state.timeline.tell(&here.context, Control::Meta(rx)) {
            index.listen(tx);
        }
    }
    Ok(true)
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
    state
        .timeline
        .keep_saved(keep, with_config(move |config| config.timeline.keep = keep))
        .await
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
