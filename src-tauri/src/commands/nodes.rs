//! Node commands

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{
    get_cluster_resource_info, list_cluster_resource_infos, ResourceContext,
};
use crate::error::Result;
use crate::resources::NodeInfo;
use crate::state::AppState;
use k8s_openapi::api::core::v1::{Node, Pod};
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
    let mut nodes: Vec<NodeInfo> =
        list_cluster_resource_infos::<Node, NodeInfo>(Some(base_filters), state).await?;

    if filters.ready_only.unwrap_or(false) {
        nodes.retain(|n| n.status.ready);
    }

    Ok(nodes)
}

/// Get a single node by name
#[tauri::command]
pub async fn get_node(name: String, state: State<'_, AppState>) -> Result<NodeInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    get_cluster_resource_info::<Node, NodeInfo>(name, state).await
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

/// Why a pod is still on the node when the drain stops.
///
/// A code rather than a sentence: the reader's language is chosen in the
/// webview, and a refusal phrased here would arrive in whatever language
/// this file happens to be written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DrainRefusal {
    /// HTTP 429 — the API declined this eviction *for now*, and the same
    /// call may well succeed a moment later.
    ///
    /// Deliberately not called "budget". Kubernetes answers 429 both for a
    /// spent `PodDisruptionBudget` and for its own request throttling, and
    /// `kube::core::ErrorResponse` in 0.97 is flattened to
    /// status/message/reason/code — it carries neither `details.causes`,
    /// which is where `DisruptionBudget` would be named, nor `Retry-After`.
    /// Which of the two this is cannot be known from here, so it is not
    /// claimed. The drain dialog reads the budgets from the cluster itself
    /// and names them from that instead.
    NotNow,
    /// No controller owns this pod, so evicting it ends it for good.
    /// Left where it is unless `evict_unmanaged_pods` says otherwise —
    /// which is what `kubectl drain` spends `--force` on.
    NothingWouldReplaceIt,
    /// The pod has an `emptyDir`, whose contents do not outlive it.
    /// Needs `evict_pods_with_emptydir`, as `kubectl drain` needs
    /// `--delete-emptydir-data`.
    HoldsLocalData,
    /// Anything else. `message` carries the API's own words, which is all
    /// there is when this app has no name for the failure.
    Other,
}

/// One pod the drain left where it was, and why.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedPod {
    pub namespace: String,
    pub name: String,
    pub refusal: DrainRefusal,
    /// Set only for `Other`, and quoted rather than composed.
    pub message: Option<String>,
}

impl RefusedPod {
    /// The three refusals this app has a name for. `Other` is built by hand,
    /// because it is the only one that carries words.
    fn new(namespace: String, name: String, refusal: DrainRefusal) -> Self {
        Self {
            namespace,
            name,
            refusal,
            message: None,
        }
    }
}

/// What a drain did, as opposed to whether it threw.
///
/// A report rather than `Result<()>`, because a drain that moved forty pods
/// and was refused one is neither a success nor a failure, and the old
/// signature had to pick. It picked failure and joined the refusals into a
/// single error string — which put English somewhere the catalogue cannot
/// reach, and left the dialog a blob to print instead of a list to walk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainReport {
    /// Pods this drain evicted.
    pub evicted: u32,
    /// Pods that had already left between the listing and their turn.
    /// Neither evicted by this drain nor refused by anything — kept apart
    /// from both so that neither count claims them.
    pub already_gone: u32,
    /// `DaemonSet` pods left in place, which is the whole of what
    /// `ignore_daemonsets` does.
    pub daemonset_pods_left: u32,
    /// Everything still on the node, in the order it was met.
    pub refused: Vec<RefusedPod>,
}

/// What the drain has decided about one pod, before it calls anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PodPlan {
    /// A `DaemonSet` pod under `ignore_daemonsets`. It stays, and that is not a
    /// refusal — nothing was ever asked of it.
    LeaveDaemonSet,
    /// In the set.
    Evict,
    /// Out of the set, for a reason the report can name.
    Leave(DrainRefusal),
}

/// Decide about one pod from its spec alone.
///
/// Split out of the loop so the membership rules can be tested without a
/// cluster: which pods a drain touches is the half of this command that
/// decides whether anything is lost by running it.
fn plan_for(
    pod: &Pod,
    ignore_daemonsets: bool,
    evict_unmanaged: bool,
    evict_emptydir: bool,
) -> PodPlan {
    let owners = pod.metadata.owner_references.as_deref().unwrap_or_default();

    if ignore_daemonsets && owners.iter().any(|r| r.kind == "DaemonSet") {
        return PodPlan::LeaveDaemonSet;
    }

    if owners.is_empty() && !evict_unmanaged {
        return PodPlan::Leave(DrainRefusal::NothingWouldReplaceIt);
    }

    let holds_local_data = pod
        .spec
        .as_ref()
        .and_then(|spec| spec.volumes.as_ref())
        .is_some_and(|volumes| volumes.iter().any(|v| v.empty_dir.is_some()));

    if holds_local_data && !evict_emptydir {
        return PodPlan::Leave(DrainRefusal::HoldsLocalData);
    }

    PodPlan::Evict
}

/// How one eviction call turned out.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Evicted {
    Yes,
    /// It had already left. Not this drain's doing, and not a refusal either.
    AlreadyGone,
    /// It is still on the node. There is deliberately no fourth arm that
    /// reaches for `DELETE` instead.
    No(DrainRefusal, Option<String>),
}

/// Read one failed eviction.
///
/// This is the half the security report was about. Every arm leaves the pod
/// where it is; the version this replaced turned *any* of them into a direct
/// `DELETE`, which is the one call that does not consult a
/// `PodDisruptionBudget`.
fn outcome_of(err: kube::Error) -> Evicted {
    if let kube::Error::Api(response) = &err {
        match response.code {
            404 | 410 => return Evicted::AlreadyGone,
            429 => return Evicted::No(DrainRefusal::NotNow, None),
            _ => {}
        }
    }

    let message = crate::state::readable_cause(&crate::error::Error::KubeApi(err));
    Evicted::No(DrainRefusal::Other, Some(message))
}

/// Drain a node: cordon it, then evict the pods it is allowed to.
///
/// **Eviction only, always.** The eviction API is the thing that consults a
/// `PodDisruptionBudget`; a `DELETE` simply goes around it. An earlier version
/// fell back to `DELETE` whenever an eviction returned *any* error, and the
/// UI passed the flag that enabled it on every single drain — so a budget
/// that refused an eviction had the pod deleted out from under it a moment
/// later, while the dialog was still on screen promising the drain would
/// wait. There is deliberately no flag here to bring that back: a tool that
/// quietly voids the guarantee a workload was configured with is worse than
/// one that stops and names what is holding it.
///
/// The two opt-ins decide which pods are *in* the set, not how they leave it
/// — the same distinction `kubectl drain` draws with `--force` and
/// `--delete-emptydir-data`, both of which still evict.
#[tauri::command]
pub async fn drain_node(
    name: String,
    ignore_daemonsets: Option<bool>,
    evict_unmanaged_pods: Option<bool>,
    evict_pods_with_emptydir: Option<bool>,
    state: State<'_, AppState>,
) -> Result<DrainReport> {
    crate::validation::validate_dns_subdomain(&name)?;
    // Cordon first, so nothing new lands on the node while what is already
    // there is being moved.
    cordon_node(name.clone(), state.clone()).await?;

    let ctx = ResourceContext::for_list(&state, None)?;
    let api: kube::Api<Pod> = ctx.namespaced_or_cluster_api();

    let params = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let pods = api.list(&params).await?;

    let ignore_daemonsets = ignore_daemonsets.unwrap_or(true);
    let evict_unmanaged = evict_unmanaged_pods.unwrap_or(false);
    let evict_emptydir = evict_pods_with_emptydir.unwrap_or(false);

    let mut report = DrainReport {
        evicted: 0,
        already_gone: 0,
        daemonset_pods_left: 0,
        refused: Vec::new(),
    };

    for pod in pods.items {
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let namespace = pod
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());

        match plan_for(&pod, ignore_daemonsets, evict_unmanaged, evict_emptydir) {
            PodPlan::LeaveDaemonSet => {
                report.daemonset_pods_left += 1;
                continue;
            }
            PodPlan::Leave(refusal) => {
                report
                    .refused
                    .push(RefusedPod::new(namespace, pod_name, refusal));
                continue;
            }
            PodPlan::Evict => {}
        }

        let pod_ctx = ResourceContext::for_command(&state, Some(namespace.clone()))?;
        let pod_api: kube::Api<Pod> = pod_ctx.namespaced_api();

        let outcome = match pod_api
            .evict(&pod_name, &kube::api::EvictParams::default())
            .await
        {
            Ok(_) => Evicted::Yes,
            Err(err) => outcome_of(err),
        };

        match outcome {
            Evicted::Yes => {
                tracing::info!("Evicted pod {}/{}", namespace, pod_name);
                report.evicted += 1;
            }
            Evicted::AlreadyGone => report.already_gone += 1,
            Evicted::No(refusal, message) => {
                tracing::info!(
                    "Pod {}/{} stays: {:?}{}",
                    namespace,
                    pod_name,
                    refusal,
                    message
                        .as_deref()
                        .map_or_else(String::new, |m| format!(" — {m}"))
                );
                report.refused.push(RefusedPod {
                    namespace,
                    name: pod_name,
                    refusal,
                    message,
                });
            }
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::{outcome_of, plan_for, DrainRefusal, Evicted, PodPlan};
    use k8s_openapi::api::core::v1::{
        EmptyDirVolumeSource, PersistentVolumeClaimVolumeSource, Pod, PodSpec, Volume,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};

    fn owner(kind: &str) -> OwnerReference {
        OwnerReference {
            kind: kind.to_string(),
            name: "owner".to_string(),
            uid: "u".to_string(),
            api_version: "apps/v1".to_string(),
            ..Default::default()
        }
    }

    fn pod(owners: Vec<OwnerReference>, volumes: Vec<Volume>) -> Pod {
        Pod {
            metadata: ObjectMeta {
                name: Some("p".to_string()),
                namespace: Some("n".to_string()),
                owner_references: if owners.is_empty() {
                    None
                } else {
                    Some(owners)
                },
                ..Default::default()
            },
            spec: Some(PodSpec {
                volumes: if volumes.is_empty() {
                    None
                } else {
                    Some(volumes)
                },
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn scratch() -> Volume {
        Volume {
            name: "scratch".to_string(),
            empty_dir: Some(EmptyDirVolumeSource::default()),
            ..Default::default()
        }
    }

    fn api_error(code: u16) -> kube::Error {
        kube::Error::Api(kube::error::ErrorResponse {
            status: "Failure".into(),
            message: format!("the server responded with {code}"),
            reason: "Whatever".into(),
            code,
        })
    }

    // --- which pods are in the set ------------------------------------------

    #[test]
    fn an_ordinary_replaceable_pod_is_evicted() {
        let plan = plan_for(&pod(vec![owner("ReplicaSet")], vec![]), true, false, false);
        assert_eq!(plan, PodPlan::Evict);
    }

    /// Left alone, and counted apart from the refusals: a `DaemonSet` pod that
    /// stays is the option working, not something declining to move.
    #[test]
    fn a_daemonset_pod_is_left_without_being_called_refused() {
        let ds = pod(vec![owner("DaemonSet")], vec![]);
        assert_eq!(plan_for(&ds, true, false, false), PodPlan::LeaveDaemonSet);
        assert_eq!(plan_for(&ds, false, false, false), PodPlan::Evict);
    }

    /// `kubectl drain` refuses these without `--force` because nothing will
    /// bring them back. The old code shipped that opt-in switched permanently
    /// on, so a drain silently ended every standalone pod it met.
    #[test]
    fn a_pod_no_controller_owns_stays_until_it_is_asked_for() {
        let bare = pod(vec![], vec![]);
        assert_eq!(
            plan_for(&bare, true, false, false),
            PodPlan::Leave(DrainRefusal::NothingWouldReplaceIt)
        );
        assert_eq!(plan_for(&bare, true, true, false), PodPlan::Evict);
    }

    #[test]
    fn a_pod_holding_local_data_stays_until_it_is_asked_for() {
        let with_data = pod(vec![owner("ReplicaSet")], vec![scratch()]);
        assert_eq!(
            plan_for(&with_data, true, false, false),
            PodPlan::Leave(DrainRefusal::HoldsLocalData)
        );
        assert_eq!(plan_for(&with_data, true, false, true), PodPlan::Evict);
    }

    /// A volume that is not an `emptyDir` survives the pod, so it is not a
    /// reason to hold one back.
    #[test]
    fn a_mounted_volume_that_outlives_the_pod_is_not_local_data() {
        let mounted = Volume {
            name: "data".to_string(),
            persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource::default()),
            ..Default::default()
        };
        let plan = plan_for(
            &pod(vec![owner("StatefulSet")], vec![mounted]),
            true,
            false,
            false,
        );
        assert_eq!(plan, PodPlan::Evict);
    }

    /// Both opt-ins are off and both apply: the first one met is the one
    /// reported, and either way the pod does not move.
    #[test]
    fn a_pod_that_trips_both_rules_still_stays() {
        let both = pod(vec![], vec![scratch()]);
        assert!(matches!(
            plan_for(&both, true, false, false),
            PodPlan::Leave(_)
        ));
        // Answering only the first still leaves the second holding it.
        assert_eq!(
            plan_for(&both, true, true, false),
            PodPlan::Leave(DrainRefusal::HoldsLocalData)
        );
    }

    // --- what a failed eviction means ---------------------------------------

    /// The reported bug, as a test. A 429 is the eviction API saying "not
    /// now" — most often a spent `PodDisruptionBudget`. The old code answered
    /// it with a direct `DELETE`, which is the one call that does not consult
    /// the budget at all.
    #[test]
    fn a_refused_eviction_leaves_the_pod_where_it_is() {
        assert_eq!(
            outcome_of(api_error(429)),
            Evicted::No(DrainRefusal::NotNow, None)
        );
    }

    /// Deliberately not named after the budget. Kubernetes answers 429 for
    /// throttling too, and nothing in `ErrorResponse` tells the two apart.
    #[test]
    fn the_refusal_does_not_claim_to_know_which_429_it_was() {
        let Evicted::No(refusal, message) = outcome_of(api_error(429)) else {
            panic!("a 429 leaves the pod");
        };
        assert_eq!(refusal, DrainRefusal::NotNow);
        assert!(
            message.is_none(),
            "no words here: the dialog reads the budgets itself"
        );
    }

    /// It left on its own between the listing and its turn. Neither an
    /// eviction this drain performed nor a refusal — the third state.
    #[test]
    fn a_pod_that_already_left_is_neither_evicted_nor_refused() {
        assert_eq!(outcome_of(api_error(404)), Evicted::AlreadyGone);
        assert_eq!(outcome_of(api_error(410)), Evicted::AlreadyGone);
    }

    /// Anything this app has no name for still leaves the pod, and carries
    /// the API's own sentence so the reader has something to act on.
    #[test]
    fn an_unrecognised_failure_leaves_the_pod_and_quotes_the_server() {
        let Evicted::No(refusal, Some(message)) = outcome_of(api_error(403)) else {
            panic!("an unrecognised failure leaves the pod and says why");
        };
        assert_eq!(refusal, DrainRefusal::Other);
        assert!(message.contains("403"), "got {message:?}");
    }

    /// Not every failure is an API rejection — a dropped connection has no
    /// HTTP code at all, and must not fall through to anything destructive.
    #[test]
    fn a_transport_failure_also_leaves_the_pod() {
        let err = kube::Error::LinesCodecMaxLineLengthExceeded;
        assert!(matches!(
            outcome_of(err),
            Evicted::No(DrainRefusal::Other, Some(_))
        ));
    }
}
