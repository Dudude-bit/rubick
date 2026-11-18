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
    // it" is a claim about one engine. Read again while the map is open.
    let others = Discovery {
        served: state.client_manager.served(),
        context: &here.context,
    }
    .other_policies(&here.client, None)
    .await;
    let (types, unresolved) = crate::topology::types_of(&here).await;
    let resolve: crate::topology::Resolve = {
        let manager = state.client_manager.clone();
        let context = here.context.clone();
        Arc::new(move |kind| {
            let manager = manager.clone();
            let context = context.clone();
            Box::pin(async move {
                let client = manager.get_client(&context).ok_or_else(|| {
                    crate::error::Error::Internal(crate::error::messages::NO_CLUSTER.to_string())
                        .said()
                })?;
                let key = kind.key();
                manager
                    .served()
                    .resource(&context, &client, &key.group, &key.plural)
                    .await
                    .map(|served| served.map(|served| served.resource))
                    .map_err(|error| error.said())
            })
        })
    };
    let subscription = state
        .feeds
        .subscribe(&here, crate::topology::ask(scope.clone()))
        .await?;
    let map = Arc::new(if scope.is_some() {
        ClusterMap::scoped()
    } else {
        ClusterMap::default()
    });
    tokio::spawn(crate::topology::pump(
        subscription.updates,
        map.clone(),
        types,
        unresolved,
        Some(resolve),
    ));
    let stream_id = generate_id("map");
    let mut opened = state.topology_streams.open(stream_id.clone());
    let events = state.event_tx.clone();
    let id = stream_id.clone();
    let lease = subscription.lease;
    let session: crate::topology::SessionCheck = {
        let manager = state.client_manager.clone();
        let context = here.context.clone();
        Arc::new(move || {
            let client = manager.get_client(&context);
            Box::pin(async move {
                match client?.apiserver_version().await {
                    Err(error) => match crate::error::Error::from(error) {
                        expired @ crate::error::Error::CredentialsExpired(_) => {
                            Some(expired.to_string())
                        }
                        _ => None,
                    },
                    Ok(_) => None,
                }
            })
        })
    };
    let reread: crate::topology::Reread = {
        let manager = state.client_manager.clone();
        let context = here.context.clone();
        Arc::new(move || {
            let manager = manager.clone();
            let context = context.clone();
            Box::pin(async move {
                let client = manager.get_client(&context)?;
                Some(
                    Discovery {
                        served: manager.served(),
                        context: &context,
                    }
                    .other_policies(&client, None)
                    .await,
                )
            })
        })
    };
    tokio::spawn(async move {
        let end = if opened.wait_for_subscriber(SUBSCRIBE_TIMEOUT).await {
            let (cancel, _held) = opened.split();
            crate::topology::run(Opening {
                stream_id: id.clone(),
                scope,
                others,
                reread: Some(reread),
                session: Some(session),
                map,
                events: events.clone(),
                cancel,
                lease: Some(lease),
                ask_at_most: crate::topology::ASK_AT_MOST,
                touch_every: crate::topology::TOUCH_EVERY,
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
