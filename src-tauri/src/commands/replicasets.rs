//! `ReplicaSet` commands.
//!
//! There is no `list_replicasets`: nobody browses this kind, so the app has
//! no list page to feed. The three questions it does ask are "which revision
//! is this", "what is it running" and "which revisions does this Deployment
//! have" — and the last one lives here rather than beside
//! `get_deployment_pods` because of what it returns.

use crate::commands::helpers::{build_label_selector, ResourceContext};
use crate::error::{Error, Result};
use crate::resources::{PodInfo, ReplicaSetInfo, REVISION_ANNOTATION};
use crate::state::AppState;
use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet};
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, ResourceExt};
use tauri::State;

#[tauri::command]
pub async fn get_replicaset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ReplicaSetInfo> {
    crate::validation::validate_dns_label(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;
    let rs: ReplicaSet = ctx.namespaced_api().get(&name).await?;
    let current = owner_revision(&ctx, &rs).await;
    Ok(ReplicaSetInfo::of(&rs, current))
}

/// The pods this revision is running.
///
/// By the `ReplicaSet`'s own selector, which carries `pod-template-hash` —
/// so it names this revision's pods exactly, where the Deployment's
/// selector would return every revision's at once.
#[tauri::command]
pub async fn get_replicaset_pods(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<PodInfo>> {
    crate::validation::validate_dns_label(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;

    let rs: ReplicaSet = ctx.namespaced_api().get(&name).await?;
    let selector = rs
        .spec
        .and_then(|s| s.selector.match_labels)
        .ok_or_else(|| Error::InvalidInput("ReplicaSet has no selector".to_string()))?;

    let params = kube::api::ListParams::default().labels(&build_label_selector(&selector));
    let pods = ctx.namespaced_api::<Pod>().list(&params).await?;

    Ok(pods.items.iter().map(PodInfo::from).collect())
}

/// A Deployment's revisions, newest first.
///
/// Filtered by owner rather than by the selector alone: a selector match is
/// what makes a `ReplicaSet` a *candidate* for adoption, and the controller
/// reference is what says it was adopted.
#[tauri::command]
pub async fn get_deployment_replicasets(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ReplicaSetInfo>> {
    crate::validation::validate_dns_label(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;

    let deployment: Deployment = ctx.namespaced_api().get(&name).await?;
    let uid = deployment.uid().unwrap_or_default();
    let current = deployment.annotations().get(REVISION_ANNOTATION).cloned();

    let selector = deployment
        .spec
        .as_ref()
        .and_then(|s| s.selector.match_labels.as_ref())
        .ok_or_else(|| Error::InvalidInput("Deployment has no selector".to_string()))?;

    let params = kube::api::ListParams::default().labels(&build_label_selector(selector));
    let list = ctx.namespaced_api::<ReplicaSet>().list(&params).await?;

    let mut revisions: Vec<ReplicaSetInfo> = list
        .items
        .iter()
        .filter(|rs| {
            rs.owner_references()
                .iter()
                .any(|owner| owner.uid == uid && owner.controller.unwrap_or(false))
        })
        .map(|rs| ReplicaSetInfo::of(rs, current.clone()))
        .collect();

    // Revision is a decimal counter the controller writes as a string, so
    // "10" sorts before "9" as text. Anything unparseable sorts last rather
    // than pretending to be revision zero.
    revisions.sort_by_key(|rs| std::cmp::Reverse(rs.revision.as_deref().and_then(parse_revision)));
    Ok(revisions)
}

fn parse_revision(value: &str) -> Option<u64> {
    value.parse().ok()
}

/// The revision the owning Deployment is on, or `None` when nothing owns
/// this `ReplicaSet`.
///
/// A failed read is `None` too, deliberately: the reader came for the
/// revision they are looking at, and losing the whole page because the
/// owner is gone or unreadable answers a smaller question with a bigger
/// failure.
async fn owner_revision(ctx: &ResourceContext, rs: &ReplicaSet) -> Option<String> {
    let owner = rs
        .owner_references()
        .iter()
        .find(|owner| owner.kind == "Deployment" && owner.controller.unwrap_or(false))?;

    let api: Api<Deployment> = ctx.namespaced_api();
    let deployment = api.get(&owner.name).await.ok()?;
    deployment.annotations().get(REVISION_ANNOTATION).cloned()
}
