//! The revisions a `StatefulSet` or `DaemonSet` has been through, read from
//! the `ControllerRevision`s the controller keeps for it.
//!
//! A `Deployment`'s history is its `ReplicaSet`s and lives in `replicasets`;
//! the other two kinds snapshot their pod template into a `ControllerRevision`
//! instead, and that is the only record of what an older revision ran.

use k8s_openapi::api::apps::v1::{
    ControllerRevision, DaemonSet, Deployment, ReplicaSet, StatefulSet,
};
use k8s_openapi::api::core::v1::PodTemplateSpec;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use kube::api::{ListParams, Patch, PatchParams};
use kube::{Api, ResourceExt};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::resources::{
    deployment_template_of, DeploymentContainerInfo, OptionTimeExt, Selector, TemplateContainers,
    REVISION_ANNOTATION,
};
use crate::state::AppState;

/// Both controllers copy the workload's own annotations onto the revision
/// they cut, so the cause lives on the `ControllerRevision` itself.
/// `kubectl rollout history` denormalises it onto the template only to print
/// it, which is why reading the template's copy finds nothing.
const CHANGE_CAUSE: &str = "kubernetes.io/change-cause";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerRevisionInfo {
    pub name: String,
    pub revision: i64,
    /// The revision the controller is rolling out or has rolled out.
    pub current: bool,
    pub change_cause: Option<String>,
    /// Whether the snapshot in `data` parsed. False leaves every field below
    /// empty because nothing was read, not because the revision ran nothing.
    pub template_read: bool,
    pub containers: Vec<DeploymentContainerInfo>,
    pub init_containers: Vec<DeploymentContainerInfo>,
    pub template_annotations: BTreeMap<String, String>,
    /// The whole template, for comparing revisions on every field.
    pub template: Option<serde_json::Value>,
    pub created_at: Option<String>,
}

/// A `StatefulSet`'s or `DaemonSet`'s revisions, newest first.
///
/// Owned by controller reference, the same rule `get_deployment_replicasets`
/// applies: a label match is a candidate, the owner reference is the claim.
#[tauri::command]
pub async fn get_controller_revisions(
    kind: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ControllerRevisionInfo>> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;
    let History {
        update_revision,
        owned,
        ..
    } = controller_history(&ctx, &kind, &name).await?;
    let owned: Vec<&ControllerRevision> = owned.iter().collect();
    // A `DaemonSet`'s status names no revision; the newest one is the one it
    // is converging on.
    let newest = owned.iter().map(|cr| cr.revision).max();

    let mut revisions: Vec<ControllerRevisionInfo> = owned
        .iter()
        .map(|cr| {
            let template = template_of(cr);
            let containers =
                TemplateContainers::of(template.as_ref().and_then(|t| t.spec.as_ref()));
            let annotations = template
                .as_ref()
                .and_then(|t| t.metadata.as_ref())
                .and_then(|m| m.annotations.clone())
                .unwrap_or_default();
            ControllerRevisionInfo {
                name: cr.name_any(),
                revision: cr.revision,
                current: match &update_revision {
                    Some(update) => cr.name_any() == *update,
                    None => Some(cr.revision) == newest,
                },
                change_cause: cr
                    .annotations()
                    .get(CHANGE_CAUSE)
                    .or_else(|| annotations.get(CHANGE_CAUSE))
                    .cloned(),
                template_read: template.is_some(),
                containers: containers.containers,
                init_containers: containers.init_containers,
                template_annotations: annotations,
                template: template.as_ref().and_then(|t| serde_json::to_value(t).ok()),
                created_at: cr.metadata.creation_timestamp.as_ref().to_rfc3339_opt(),
            }
        })
        .collect();
    revisions.sort_by_key(|r| std::cmp::Reverse(r.revision));
    Ok(revisions)
}

/// What a `StatefulSet` or `DaemonSet` is running now and every revision it
/// owns, by controller reference.
struct History {
    update_revision: Option<String>,
    template: Option<PodTemplateSpec>,
    owned: Vec<ControllerRevision>,
}

async fn controller_history(ctx: &ResourceContext, kind: &str, name: &str) -> Result<History> {
    let (uid, update_revision, selector, template) = match kind {
        "StatefulSet" => {
            let sts: StatefulSet = ctx.namespaced_api().get(name).await?;
            let update = sts.status.as_ref().and_then(|s| s.update_revision.clone());
            let spec = sts.spec.as_ref();
            (
                sts.uid().unwrap_or_default(),
                update,
                label_selector(spec.map(|s| &s.selector)),
                spec.map(|s| s.template.clone()),
            )
        }
        "DaemonSet" => {
            let ds: DaemonSet = ctx.namespaced_api().get(name).await?;
            let spec = ds.spec.as_ref();
            (
                ds.uid().unwrap_or_default(),
                None,
                label_selector(spec.map(|s| &s.selector)),
                spec.map(|s| s.template.clone()),
            )
        }
        other => {
            return Err(Error::InvalidInput(format!(
                "{other} keeps no ControllerRevisions"
            )))
        }
    };

    let api: Api<ControllerRevision> = ctx.namespaced_api();
    // The owner reference is still the claim; the selector only keeps the
    // namespace's other workloads' revisions off the wire.
    let params = match &selector {
        Some(labels) => ListParams::default().labels(labels),
        None => ListParams::default(),
    };
    let owned = api
        .list(&params)
        .await?
        .items
        .into_iter()
        .filter(|cr| {
            cr.owner_references()
                .iter()
                .any(|owner| owner.uid == uid && owner.controller.unwrap_or(false))
        })
        .collect();
    Ok(History {
        update_revision,
        template,
        owned,
    })
}

/// What a rollback did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum RollbackOutcome {
    RolledBack,
    /// The workload already runs that revision's template; nothing was sent.
    AlreadyThere,
}

/// `kubectl rollout undo --to-revision`: the workload's template becomes the
/// one that revision recorded, which the controller then rolls out.
#[tauri::command]
pub async fn rollback_workload(
    kind: String,
    name: String,
    namespace: Option<String>,
    revision: i64,
    state: State<'_, AppState>,
) -> Result<RollbackOutcome> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;
    match kind.as_str() {
        "Deployment" => rollback_deployment(&ctx, &name, revision).await,
        _ => rollback_controller(&ctx, &kind, &name, revision).await,
    }
}

/// kubectl's own list: what a rollback keeps from the Deployment rather than
/// taking from the `ReplicaSet`.
const KEPT_ANNOTATIONS: [&str; 6] = [
    "kubectl.kubernetes.io/last-applied-configuration",
    "deployment.kubernetes.io/revision",
    "deployment.kubernetes.io/revision-history",
    "deployment.kubernetes.io/desired-replicas",
    "deployment.kubernetes.io/max-replicas",
    "deprecated.deployment.rollback.to",
];

/// The Deployment's annotations after a rollback, as kubectl computes them:
/// its own bookkeeping kept, everything else (the change cause among it)
/// taken from the revision rolled back to.
fn rollback_annotations(
    deployment: &BTreeMap<String, String>,
    replica_set: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let kept = |key: &str| KEPT_ANNOTATIONS.contains(&key);
    deployment
        .iter()
        .filter(|(key, _)| kept(key))
        .chain(replica_set.iter().filter(|(key, _)| !kept(key)))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn rollback_patch(
    template: &PodTemplateSpec,
    annotations: &BTreeMap<String, String>,
) -> Result<json_patch::Patch> {
    serde_json::from_value(serde_json::json!([
        { "op": "replace", "path": "/spec/template", "value": template },
        { "op": "add", "path": "/metadata/annotations", "value": annotations },
    ]))
    .map_err(|e| Error::Internal(format!("rollback patch: {e}")))
}

fn same_template(a: &PodTemplateSpec, b: &PodTemplateSpec) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}

async fn rollback_deployment(
    ctx: &ResourceContext,
    name: &str,
    revision: i64,
) -> Result<RollbackOutcome> {
    let api: Api<Deployment> = ctx.namespaced_api();
    let deployment = api.get(name).await?;
    let spec = deployment.spec.as_ref();
    if spec.and_then(|s| s.paused).unwrap_or(false) {
        return Err(Error::InvalidInput(format!(
            "Deployment {name} is paused; resume it before rolling back"
        )));
    }
    let uid = deployment.uid().unwrap_or_default();
    let selector = Selector::Query(spec.map(|s| &s.selector))
        .query_text()
        .ok_or_else(|| Error::InvalidInput("Deployment has no selector".to_string()))?;
    let wanted = revision.to_string();
    let target = ctx
        .namespaced_api::<ReplicaSet>()
        .list(&ListParams::default().labels(&selector))
        .await?
        .items
        .into_iter()
        .find(|rs| {
            rs.owner_references()
                .iter()
                .any(|owner| owner.uid == uid && owner.controller.unwrap_or(false))
                && rs.annotations().get(REVISION_ANNOTATION) == Some(&wanted)
        })
        .ok_or_else(|| Error::NotFound {
            kind: "ReplicaSet".to_string(),
            name: format!("{name} revision {revision}"),
            namespace: ctx.namespace.clone().unwrap_or_default(),
        })?;
    let Some(template) = target.spec.as_ref().and_then(|s| s.template.as_ref()) else {
        return Err(Error::InvalidInput(format!(
            "revision {revision} of {name} records no template"
        )));
    };
    let template = deployment_template_of(template);
    if spec.is_some_and(|s| same_template(&deployment_template_of(&s.template), &template)) {
        return Ok(RollbackOutcome::AlreadyThere);
    }
    let patch = rollback_patch(
        &template,
        &rollback_annotations(deployment.annotations(), target.annotations()),
    )?;
    api.patch(name, &PatchParams::default(), &Patch::Json::<()>(patch))
        .await?;
    Ok(RollbackOutcome::RolledBack)
}

/// A `ControllerRevision`'s `data` is already a strategic merge patch of the
/// workload with only its template in it, which is what kubectl sends back.
async fn rollback_controller(
    ctx: &ResourceContext,
    kind: &str,
    name: &str,
    revision: i64,
) -> Result<RollbackOutcome> {
    let History {
        template: current,
        owned,
        ..
    } = controller_history(ctx, kind, name).await?;
    let target = owned
        .into_iter()
        .find(|cr| cr.revision == revision)
        .ok_or_else(|| Error::NotFound {
            kind: "ControllerRevision".to_string(),
            name: format!("{name} revision {revision}"),
            namespace: ctx.namespace.clone().unwrap_or_default(),
        })?;
    let (Some(data), Some(recorded)) = (target.data.as_ref(), template_of(&target)) else {
        return Err(Error::InvalidInput(format!(
            "revision {revision} of {name} records no template"
        )));
    };
    if current.is_some_and(|c| same_template(&c, &recorded)) {
        return Ok(RollbackOutcome::AlreadyThere);
    }
    let params = PatchParams::default();
    let patch = Patch::Strategic(&data.0);
    match kind {
        "StatefulSet" => {
            ctx.namespaced_api::<StatefulSet>()
                .patch(name, &params, &patch)
                .await?;
        }
        _ => {
            ctx.namespaced_api::<DaemonSet>()
                .patch(name, &params, &patch)
                .await?;
        }
    }
    Ok(RollbackOutcome::RolledBack)
}

/// `matchLabels` as one selector string. `matchExpressions` are dropped: a
/// wider list is still narrowed by the owner reference, a narrower one would
/// lose revisions.
fn label_selector(selector: Option<&LabelSelector>) -> Option<String> {
    let labels = selector?.match_labels.as_ref()?;
    if labels.is_empty() {
        return None;
    }
    Some(
        labels
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(","),
    )
}

/// The template a revision snapshotted: `data` is a patch of the owner with
/// only `spec.template` in it, for both kinds.
fn template_of(cr: &ControllerRevision) -> Option<PodTemplateSpec> {
    let data = cr.data.as_ref()?;
    let template = data.0.get("spec")?.get("template")?;
    serde_json::from_value(template.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::runtime::RawExtension;

    fn revision(data: serde_json::Value) -> ControllerRevision {
        ControllerRevision {
            data: Some(RawExtension(data)),
            revision: 3,
            ..Default::default()
        }
    }

    /// A revision whose data carries no template is a revision the app can say nothing about, not one running no containers.
    #[test]
    fn a_revision_without_a_template_yields_none() {
        assert!(template_of(&revision(serde_json::json!({"spec": {}}))).is_none());
        assert!(template_of(&revision(serde_json::json!({}))).is_none());
    }

    /// Both controllers copy the workload's annotations onto the revision;
    /// `kubectl` denormalises the cause onto the template only to print it,
    /// so reading the template's copy found nothing for every workload
    /// somebody had annotated.
    #[test]
    fn the_change_cause_is_read_from_the_revision_the_controller_wrote() {
        let mut cr = revision(serde_json::json!({"spec": {"template": {}}}));
        cr.metadata.annotations = Some(
            [(CHANGE_CAUSE.to_string(), "bump to v1.17".to_string())]
                .into_iter()
                .collect(),
        );
        assert_eq!(
            cr.annotations().get(CHANGE_CAUSE).map(String::as_str),
            Some("bump to v1.17")
        );
    }

    /// Listing every `ControllerRevision` in the namespace to keep one
    /// workload's ten is the whole namespace on the wire per open tab.
    #[test]
    fn the_workloads_own_labels_narrow_the_list() {
        assert_eq!(
            label_selector(Some(&LabelSelector {
                match_labels: Some(
                    [("app".to_string(), "fluentd".to_string())]
                        .into_iter()
                        .collect()
                ),
                ..Default::default()
            })),
            Some("app=fluentd".to_string())
        );
        assert_eq!(label_selector(None), None);
        assert_eq!(label_selector(Some(&LabelSelector::default())), None);
    }

    /// kubectl keeps the Deployment's bookkeeping and takes the change cause
    /// from the revision; taking both from either side lies about one.
    #[test]
    fn a_rollback_keeps_the_deployments_bookkeeping_and_takes_the_revisions_cause() {
        let deployment: BTreeMap<String, String> = [
            ("deployment.kubernetes.io/revision", "2"),
            (CHANGE_CAUSE, "probe on /healthz"),
            ("team", "storefront"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let replica_set: BTreeMap<String, String> = [
            ("deployment.kubernetes.io/revision", "1"),
            (CHANGE_CAUSE, "first deploy"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let after = rollback_annotations(&deployment, &replica_set);
        assert_eq!(
            after
                .get("deployment.kubernetes.io/revision")
                .map(String::as_str),
            Some("2")
        );
        assert_eq!(
            after.get(CHANGE_CAUSE).map(String::as_str),
            Some("first deploy")
        );
        assert_eq!(after.get("team"), None);
    }

    /// The patch replaces the template whole, so a field the old revision
    /// did not have is removed rather than kept by a merge.
    #[test]
    fn a_rollback_patch_replaces_the_template_and_sets_the_annotations() {
        let template: PodTemplateSpec = serde_json::from_value(serde_json::json!({
            "metadata": {"labels": {"app": "search"}},
            "spec": {"containers": [{"name": "app", "image": "nginx:1.27-alpine"}]}
        }))
        .expect("template");
        let patch = serde_json::to_value(
            rollback_patch(&template, &BTreeMap::new()).expect("patch builds"),
        )
        .expect("serialises");
        assert_eq!(patch[0]["op"], "replace");
        assert_eq!(patch[0]["path"], "/spec/template");
        assert_eq!(
            patch[0]["value"]["spec"]["containers"][0]["image"],
            "nginx:1.27-alpine"
        );
        assert_eq!(patch[1]["op"], "add");
        assert_eq!(patch[1]["path"], "/metadata/annotations");
    }

    #[test]
    fn the_template_is_read_from_the_patch_the_controller_wrote() {
        let template = template_of(&revision(serde_json::json!({
            "spec": {"template": {"metadata": {"annotations": {CHANGE_CAUSE: "bump"}},
                "spec": {"containers": [{"name": "app", "image": "app:2"}]}}}
        })))
        .expect("template");
        assert_eq!(
            template.spec.unwrap().containers[0].image.as_deref(),
            Some("app:2")
        );
        assert_eq!(
            template
                .metadata
                .unwrap()
                .annotations
                .unwrap()
                .get(CHANGE_CAUSE)
                .map(String::as_str),
            Some("bump")
        );
    }
}
