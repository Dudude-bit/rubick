//! The cluster map: a stream per window, drawn from the lists the map holds.

use tauri::State;

use crate::commands::helpers::scope_of;
use crate::commands::other_policies::Discovery;
use std::sync::Arc;

use crate::error::Result;
use crate::resources::topology::TopologyEnd;
use crate::state::streams::SUBSCRIBE_TIMEOUT;
use crate::state::{AppEvent, AppState};
use crate::topology::{ClusterMap, Opening};
use crate::utils::generate_id;

/// Start drawing the scope's map. It arrives in `topology-batch` events,
/// each under the IPC target, then `topology-ready`, then a batch per
/// change, until exactly one `topology-ended`.
#[tauri::command]
pub async fn open_topology(
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String> {
    let scope = scope_of(scope)?;
    let here = state.here()?;
    // The other engines' policies, without which "no NetworkPolicy selects
    // it" is a claim about one engine. Read once per map: they are kinds a
    // cluster installs, not objects it churns.
    let others = Discovery {
        served: state.client_manager.served(),
        context: &here.context,
    }
    .other_policies(&here.client, None)
    .await;
    let types = crate::topology::types_of(&here).await;
    let subscription = state
        .feeds
        .subscribe(&here, crate::topology::ask(scope.clone()))
        .await?;
    let map = Arc::new(ClusterMap::default());
    tokio::spawn(crate::topology::pump(
        subscription.updates,
        map.clone(),
        types,
    ));
    let stream_id = generate_id("map");
    let mut opened = state.topology_streams.open(stream_id.clone());
    let events = state.event_tx.clone();
    let id = stream_id.clone();
    let lease = subscription.lease;
    tokio::spawn(async move {
        let end = if opened.wait_for_subscriber(SUBSCRIBE_TIMEOUT).await {
            let (cancel, _held) = opened.split();
            crate::topology::run(Opening {
                stream_id: id.clone(),
                scope,
                others,
                map,
                events: events.clone(),
                cancel,
                lease: Some(lease),
            })
            .await
        } else {
            TopologyEnd::Unsubscribed
        };
        let _ = events.send(AppEvent::TopologyEnded { stream_id: id, end });
    });
    Ok(stream_id)
}

/// The frontend's listeners are up; let the map flow.
#[tauri::command]
pub fn topology_subscribed(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    let _ = state.topology_streams.subscribed(&stream_id);
    Ok(())
}

/// Stop drawing a map.
#[tauri::command]
pub fn close_topology(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    let _ = state.topology_streams.stop(&stream_id);
    Ok(())
}
