//! Node commands

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{
    get_cluster_resource_info, list_cluster_resource_infos, ResourceContext,
};
use crate::drain::{DrainHandle, DrainOptions};
use crate::error::{Error, Result};
use crate::resources::node_budget::{budget, NodeBudget};
use crate::resources::NodeInfo;
use crate::state::AppState;
use k8s_openapi::api::core::v1::{Namespace, Node, Pod};
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Node list filters
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeFilters {
    pub label_selector: Option<String>,
    pub field_selector: Option<String>,
    pub limit: Option<i64>,
    pub ready_only: Option<bool>,
}

/// The node's resource table: capacity, allocatable, and what the pods on
/// it have reserved and may burst to.
///
/// One cluster-wide list narrowed by `spec.nodeName`. Where that is refused
/// the pods are listed namespace by namespace, and a single refusal there
/// makes the sums unknown rather than smaller.
#[tauri::command]
pub async fn node_resource_budget(name: String, state: State<'_, AppState>) -> Result<NodeBudget> {
    crate::client::clock::timed(
        &state.perf,
        "nodeResourceBudget",
        budget_of_node(&state, name),
    )
    .await
}

async fn budget_of_node(state: &AppState, name: String) -> Result<NodeBudget> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_list(state, None)?;
    let node = ctx.cluster_api::<Node>().get(&name).await?;
    let params = ListParams::default().fields(&format!("spec.nodeName={name}"));

    // A read error that is not a refusal leaves the sums unknown, with the
    // reason in the budget's `error`. An expired session is the exception: it
    // must propagate as `Err`, or the frontend's re-login never fires — it
    // only watches rejected commands for the CREDENTIALS_EXPIRED prefix.
    let unknown = |err: Error| -> Result<NodeBudget> {
        if matches!(err, Error::CredentialsExpired(_)) {
            Err(err)
        } else {
            Ok(budget(&node, None, Vec::new(), Some(err.to_string())))
        }
    };

    match ctx.cluster_api::<Pod>().list(&params).await {
        Ok(list) => return Ok(budget(&node, Some(&list.items), Vec::new(), None)),
        Err(e) => {
            let err = Error::from(e);
            if !err.is_refusal() {
                return unknown(err);
            }
        }
    }

    let namespaces = match ctx
        .cluster_api::<Namespace>()
        .list(&ListParams::default())
        .await
    {
        Ok(list) => list.items,
        Err(e) => return unknown(Error::from(e)),
    };
    let mut pods = Vec::new();
    let mut refused = Vec::new();
    for namespace in namespaces {
        let Some(ns) = namespace.metadata.name else {
            continue;
        };
        let api: kube::Api<Pod> = kube::Api::namespaced(ctx.client.clone(), &ns);
        match api.list(&params).await {
            Ok(list) => pods.extend(list.items),
            Err(e) => {
                let err = Error::from(e);
                if err.is_refusal() {
                    refused.push(ns);
                } else {
                    return unknown(err);
                }
            }
        }
    }
    if refused.is_empty() {
        Ok(budget(&node, Some(&pods), Vec::new(), None))
    } else {
        Ok(budget(&node, None, refused, None))
    }
}

/// List all nodes
#[tauri::command]
pub async fn list_nodes(
    filters: Option<NodeFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<NodeInfo>> {
    let filters = filters.unwrap_or_default();
    let base_filters = ResourceFilters {
        namespace: None,
        label_selector: filters.label_selector.clone(),
        field_selector: filters.field_selector.clone(),
        limit: filters.limit,
    };
    let mut nodes: Vec<NodeInfo> = crate::client::clock::timed(
        &state.perf,
        "listNodes",
        list_cluster_resource_infos::<Node, NodeInfo>(Some(base_filters), state.clone()),
    )
    .await?;

    if filters.ready_only.unwrap_or(false) {
        nodes.retain(|n| n.status.ready);
    }

    Ok(nodes)
}

/// Get a single node by name
#[tauri::command]
pub async fn get_node(name: String, state: State<'_, AppState>) -> Result<NodeInfo> {
    crate::client::clock::timed(
        &state.perf,
        "getNode",
        get_cluster_resource_info::<Node, NodeInfo>(name, state.clone()),
    )
    .await
}

/// Cordon a node (mark as unschedulable)
#[tauri::command]
pub async fn cordon_node(name: String, state: State<'_, AppState>) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_list(&state, None)?;
    let api: kube::Api<Node> = ctx.cluster_api();

    let patch = serde_json::json!({
        "spec": { "unschedulable": true }
    });

    api.patch(
        &name,
        &kube::api::PatchParams::default(),
        &kube::api::Patch::Merge(&patch),
    )
    .await?;

    Ok(())
}

/// Uncordon a node (mark as schedulable)
#[tauri::command]
pub async fn uncordon_node(name: String, state: State<'_, AppState>) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_list(&state, None)?;
    let api: kube::Api<Node> = ctx.cluster_api();

    let patch = serde_json::json!({
        "spec": { "unschedulable": false }
    });

    api.patch(
        &name,
        &kube::api::PatchParams::default(),
        &kube::api::Patch::Merge(&patch),
    )
    .await?;

    Ok(())
}

/// Start draining a node, and return at once.
///
/// Thin on purpose. The cordon, the surveying and the waiting all belong to
/// the drain itself — see [`crate::drain`], which owns them so that starting
/// one cannot leave a step out. What is left here is the name check, a
/// client, and where to find the one a renewal replaces it with.
///
/// Everything after this arrives as `drain-progress` / `drain-finished`
/// events, including a cordon that was refused.
///
/// `context` is the cluster the dialog was opened on. The window's own may
/// be another by the time this arrives, and a drain evicts.
#[tauri::command]
pub async fn start_node_drain(
    context: String,
    name: String,
    options: DrainOptions,
    state: State<'_, AppState>,
) -> Result<DrainHandle> {
    drain_on(&state, context, name, options)
}

fn drain_on(
    state: &AppState,
    context: String,
    name: String,
    options: DrainOptions,
) -> Result<DrainHandle> {
    crate::validation::validate_dns_subdomain(&name)?;
    let client = (*state.client_of(&context)?).clone();
    let clients = state.client_manager.clone();
    let renewed = move || clients.get_client(&context).map(|held| (*held).clone());
    Ok(state.drain_manager.start(client, renewed, name, options))
}

/// Release the first event once the frontend is listening.
///
/// # Errors
///
/// Unknown ids error rather than passing quietly, so a typo in the handle
/// surfaces here and not as a drain that seems to emit nothing.
#[tauri::command]
pub fn node_drain_subscribed(drain_id: String, state: State<'_, AppState>) -> Result<()> {
    state.drain_manager.mark_subscribed(&drain_id)
}

/// Stop asking. Pods already evicted stay evicted — an eviction is not a
/// transaction, and pretending it could be undone would be the worse lie.
#[tauri::command]
pub fn cancel_node_drain(drain_id: String, state: State<'_, AppState>) {
    state.drain_manager.cancel(&drain_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::{connected, failure};
    use crate::client::served::ServedIndex;
    use crate::state::AppEvent;
    use std::time::Duration;

    fn options() -> DrainOptions {
        DrainOptions {
            ignore_daemonsets: true,
            evict_unmanaged_pods: false,
            evict_pods_with_emptydir: false,
        }
    }

    /// The dialog was opened on prod and the window is on another cluster by
    /// the time the start arrives. The start took the window's cluster, so
    /// the namesake node there was cordoned and its pods evicted. Fails if a
    /// drain asked for one cluster starts on, or so much as asks, another.
    #[tokio::test]
    async fn a_drain_asked_for_another_cluster_is_not_started_on_the_windows() {
        let (state, hits) =
            connected(ServedIndex::default(), |_, _| failure(404, "NotFound")).await;

        let refused = drain_on(&state, "prod".into(), "node-1".into(), options());

        assert!(matches!(
            refused,
            Err(Error::NotConnected(context)) if context == "prod"
        ));
        assert_eq!(state.drain_manager.active_drains(), 0);
        assert!(hits.lock().unwrap().is_empty());
    }

    /// The other half: the cluster asked for is the one cordoned, wherever
    /// the window has got to. Fails if the window's cluster decides anything.
    #[tokio::test]
    async fn a_drain_runs_on_the_cluster_it_was_asked_for() {
        let (state, hits) =
            connected(ServedIndex::default(), |_, _| failure(404, "NotFound")).await;
        state.set_current_context(Some("elsewhere".into()));
        let mut events = state.event_tx.subscribe();

        let handle = drain_on(&state, "fake".into(), "node-1".into(), options())
            .expect("the cluster it names is held");
        state
            .drain_manager
            .mark_subscribed(&handle.drain_id)
            .expect("known");

        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("an ending within five seconds")
                .expect("the channel is open");
            if matches!(event, AppEvent::DrainFinished { .. }) {
                break;
            }
        }
        assert_eq!(
            hits.lock().unwrap().get("/api/v1/nodes/node-1"),
            Some(&1),
            "the cordon went to the cluster the drain names"
        );
    }
}
