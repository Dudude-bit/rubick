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
use kube::api::{DynamicObject, ListParams, Patch, PatchParams};
use kube::{Api, ResourceExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    /// The whole template as the controller recorded it, for comparing
    /// revisions on every field.
    pub template: Option<Value>,
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
    crate::client::clock::timed(
        &state.perf,
        "getControllerRevisions",
        controller_revisions(&state, kind, name, namespace),
    )
    .await
}

async fn controller_revisions(
    state: &AppState,
    kind: String,
    name: String,
    namespace: Option<String>,
) -> Result<Vec<ControllerRevisionInfo>> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_command(state, namespace)?;
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
                template: recorded_template(cr).map(bare),
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
    workload: Api<DynamicObject>,
    update_revision: Option<String>,
    template: Option<Value>,
    owned: Vec<ControllerRevision>,
}

async fn controller_history(ctx: &ResourceContext, kind: &str, name: &str) -> Result<History> {
    let workload = match kind {
        "StatefulSet" => ctx.raw_api::<StatefulSet>(),
        "DaemonSet" => ctx.raw_api::<DaemonSet>(),
        other => {
            return Err(Error::InvalidInput(format!(
                "{other} keeps no ControllerRevisions"
            )))
        }
    };
    let read = workload.get(name).await?;
    let uid = read.uid().unwrap_or_default();
    // Only a `StatefulSet`'s status names the revision it is rolling out.
    let update_revision = read
        .data
        .pointer("/status/updateRevision")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let selector = selector_in(&read);
    let selector = label_selector(selector.as_ref());
    let template = read.data.pointer("/spec/template").cloned();

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
        workload,
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
    template: &Value,
    annotations: &BTreeMap<String, String>,
) -> Result<json_patch::Patch> {
    serde_json::from_value(serde_json::json!([
        { "op": "replace", "path": "/spec/template", "value": template },
        { "op": "add", "path": "/metadata/annotations", "value": annotations },
    ]))
    .map_err(|e| Error::Internal(format!("rollback patch: {e}")))
}

/// A template without what is no field of it: a `null`, and the `$patch`
/// directive both controllers write into the revision they record.
fn bare(template: &Value) -> Value {
    fn without_nulls(value: &Value) -> Value {
        match value {
            Value::Object(fields) => fields
                .iter()
                .filter(|(_, field)| !field.is_null())
                .map(|(key, field)| (key.clone(), without_nulls(field)))
                .collect(),
            Value::Array(items) => items.iter().map(without_nulls).collect(),
            other => other.clone(),
        }
    }
    let mut bare = without_nulls(template);
    if let Some(fields) = bare.as_object_mut() {
        fields.remove("$patch");
    }
    bare
}

/// Compared as the cluster wrote them, so two templates that differ only in
/// a field newer than the bindings are not the same.
fn same_template(a: &Value, b: &Value) -> bool {
    bare(a) == bare(b)
}

fn selector_in(workload: &DynamicObject) -> Option<LabelSelector> {
    serde_json::from_value(workload.data.pointer("/spec/selector")?.clone()).ok()
}

async fn rollback_deployment(
    ctx: &ResourceContext,
    name: &str,
    revision: i64,
) -> Result<RollbackOutcome> {
    let Some(patch) = deployment_rollback(ctx, name, revision).await? else {
        return Ok(RollbackOutcome::AlreadyThere);
    };
    ctx.raw_api::<Deployment>()
        .patch(name, &PatchParams::default(), &Patch::Json::<()>(patch))
        .await?;
    Ok(RollbackOutcome::RolledBack)
}

/// What rolling a Deployment back to a revision sends, or `None` where it
/// already runs that revision's template.
async fn deployment_rollback(
    ctx: &ResourceContext,
    name: &str,
    revision: i64,
) -> Result<Option<json_patch::Patch>> {
    let deployment = ctx.raw_api::<Deployment>().get(name).await?;
    let paused = deployment.data.pointer("/spec/paused");
    if paused.and_then(Value::as_bool).unwrap_or(false) {
        return Err(Error::InvalidInput(format!(
            "Deployment {name} is paused; resume it before rolling back"
        )));
    }
    let uid = deployment.uid().unwrap_or_default();
    let selector = Selector::Query(selector_in(&deployment).as_ref())
        .query_text()
        .ok_or_else(|| Error::InvalidInput("Deployment has no selector".to_string()))?;
    let wanted = revision.to_string();
    let target = ctx
        .raw_api::<ReplicaSet>()
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
    let recorded = target.data.pointer("/spec/template");
    let Some(template) = recorded.filter(|template| template.is_object()) else {
        return Err(Error::InvalidInput(format!(
            "revision {revision} of {name} records no template"
        )));
    };
    let template = deployment_template_of(template);
    let current = deployment.data.pointer("/spec/template");
    if current.is_some_and(|current| same_template(&deployment_template_of(current), &template)) {
        return Ok(None);
    }
    rollback_patch(
        &template,
        &rollback_annotations(deployment.annotations(), target.annotations()),
    )
    .map(Some)
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
        workload,
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
    let (Some(data), Some(recorded)) = (target.data.as_ref(), recorded_template(&target)) else {
        return Err(Error::InvalidInput(format!(
            "revision {revision} of {name} records no template"
        )));
    };
    if current.is_some_and(|current| same_template(&current, recorded)) {
        return Ok(RollbackOutcome::AlreadyThere);
    }
    workload
        .patch(name, &PatchParams::default(), &Patch::Strategic(&data.0))
        .await?;
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

/// The template a revision snapshotted, as the controller wrote it: `data`
/// is a patch of the owner with only `spec.template` in it, for both kinds.
fn recorded_template(cr: &ControllerRevision) -> Option<&Value> {
    let template = cr.data.as_ref()?.0.pointer("/spec/template")?;
    template.is_object().then_some(template)
}

/// The same template through the bindings, for the rows that name its
/// containers. Whole-template questions read [`recorded_template`].
fn template_of(cr: &ControllerRevision) -> Option<PodTemplateSpec> {
    serde_json::from_value(recorded_template(cr)?.clone()).ok()
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
        let template = serde_json::json!({
            "metadata": {"labels": {"app": "search"}},
            "spec": {"containers": [{"name": "app", "image": "nginx:1.27-alpine"}]}
        });
        let patch = serde_json::to_value(
            rollback_patch(&template, &BTreeMap::new()).expect("patch builds"),
        )
        .expect("serialises");
        assert_eq!(patch[0]["op"], "replace");
        assert_eq!(patch[0]["path"], "/spec/template");
        assert_eq!(patch[0]["value"], template);
        assert_eq!(patch[1]["op"], "add");
        assert_eq!(patch[1]["path"], "/metadata/annotations");
    }

    /// A pod template with fields Kubernetes 1.34 added, which the bindings
    /// (1.32) do not have.
    fn template(image: &str, hostname: &str, hash: Option<&str>) -> Value {
        let mut labels = serde_json::json!({"app": "api"});
        if let Some(hash) = hash {
            labels["pod-template-hash"] = hash.into();
        }
        serde_json::json!({
            "metadata": {"labels": labels, "creationTimestamp": null},
            "spec": {
                "hostnameOverride": hostname,
                "containers": [{
                    "name": "app", "image": image,
                    "lifecycle": {"stopSignal": "SIGUSR1"},
                    "restartPolicyRules": [{"action": "Restart"}],
                    "env": [{"name": "TOKEN", "valueFrom": {"fileKeyRef": {"path": "t", "key": "k", "volumeName": "v"}}}],
                }],
            },
        })
    }

    fn replica_set(revision: &str, template: &Value) -> Value {
        serde_json::json!({
            "apiVersion": "apps/v1", "kind": "ReplicaSet",
            "metadata": {
                "name": format!("api-{revision}"), "namespace": "shop",
                "annotations": {REVISION_ANNOTATION: revision},
                "ownerReferences": [{"apiVersion": "apps/v1", "kind": "Deployment",
                    "name": "api", "uid": "api-uid", "controller": true}],
            },
            "spec": {"selector": {"matchLabels": {"app": "api"}}, "template": template},
        })
    }

    /// What a rollback of Deployment `api` to revision 4 sends, on a cluster
    /// where it runs `current` and revision 4 recorded `fourth`.
    async fn rolled_back(current: Value, fourth: Value) -> Option<Value> {
        use crate::client::served::{test_server::connected, ServedIndex};
        let (state, _) = connected(ServedIndex::default(), move |path, _| match path {
            "/apis/apps/v1/namespaces/shop/deployments/api" => (
                200,
                serde_json::json!({
                    "apiVersion": "apps/v1", "kind": "Deployment",
                    "metadata": {"name": "api", "namespace": "shop", "uid": "api-uid",
                        "annotations": {REVISION_ANNOTATION: "5"}},
                    "spec": {"selector": {"matchLabels": {"app": "api"}}, "template": current},
                })
                .to_string(),
            ),
            "/apis/apps/v1/namespaces/shop/replicasets" => (
                200,
                serde_json::json!({
                    "apiVersion": "apps/v1", "kind": "ReplicaSetList", "metadata": {},
                    "items": [replica_set("4", &fourth)],
                })
                .to_string(),
            ),
            _ => (404, "{}".into()),
        })
        .await;
        let ctx = ResourceContext::for_command(&state, Some("shop".into())).expect("context");
        let patch = deployment_rollback(&ctx, "api", 4).await.expect("answers");
        patch.map(|patch| serde_json::to_value(patch).expect("serialises")[0]["value"].clone())
    }

    /// The bindings drop what they do not know, and the patch replaces the
    /// template whole, so a rollback through them took the stop signal, the
    /// hostname and the restart rules off the Deployment and emptied a
    /// `fileKeyRef` into a `valueFrom` the API server refuses. Fails if the
    /// revision is read or written through typed structs.
    #[tokio::test]
    async fn rolling_a_deployment_back_sends_the_template_as_the_cluster_recorded_it() {
        let sent = rolled_back(
            template("api:5", "main", None),
            template("api:4", "main", Some("7d4")),
        )
        .await
        .expect("a patch");
        assert_eq!(sent, template("api:4", "main", None));
    }

    /// Two revisions that differ only in a field newer than the bindings read
    /// as one template through them, so the rollback answered "already
    /// there" and sent nothing. Fails if the comparison is typed; the second
    /// half fails if a revision the Deployment does run is patched anyway.
    #[tokio::test]
    async fn a_revision_differing_only_in_a_field_the_bindings_lack_is_still_rolled_back_to() {
        let sent = rolled_back(
            template("api:5", "main", None),
            template("api:5", "canary", Some("7d4")),
        )
        .await
        .expect("a patch");
        assert_eq!(sent["spec"]["hostnameOverride"], "canary");

        let same = rolled_back(
            template("api:5", "main", None),
            template("api:5", "main", Some("7d4")),
        )
        .await;
        assert_eq!(same, None);
    }

    /// A cluster where `StatefulSet` `db` runs `current` and its revision 1
    /// recorded `first`.
    async fn a_set(current: Value, first: Value) -> AppState {
        use crate::client::served::{test_server::connected, ServedIndex};
        let (state, _) = connected(ServedIndex::default(), move |path, _| match path {
            "/apis/apps/v1/namespaces/shop/statefulsets/db" => (
                200,
                serde_json::json!({
                    "apiVersion": "apps/v1", "kind": "StatefulSet",
                    "metadata": {"name": "db", "namespace": "shop", "uid": "db-uid"},
                    "spec": {"selector": {"matchLabels": {"app": "api"}}, "template": current},
                })
                .to_string(),
            ),
            "/apis/apps/v1/namespaces/shop/controllerrevisions" => (
                200,
                serde_json::json!({
                    "apiVersion": "apps/v1", "kind": "ControllerRevisionList", "metadata": {},
                    "items": [{
                        "metadata": {"name": "db-1", "namespace": "shop",
                            "ownerReferences": [{"apiVersion": "apps/v1", "kind": "StatefulSet",
                                "name": "db", "uid": "db-uid", "controller": true}]},
                        "revision": 1,
                        "data": {"spec": {"template": first}},
                    }],
                })
                .to_string(),
            ),
            _ => (404, "{}".into()),
        })
        .await;
        state
    }

    async fn set_rolled_back(current: Value, first: Value) -> RollbackOutcome {
        let state = a_set(current, first).await;
        let ctx = ResourceContext::for_command(&state, Some("shop".into())).expect("context");
        rollback_controller(&ctx, "StatefulSet", "db", 1)
            .await
            .expect("answers")
    }

    /// The same blindness in the other two kinds' "already there": the
    /// revision's patch was sent raw, but whether to send it was decided on
    /// typed copies. The controller's own `$patch` and an empty
    /// `creationTimestamp` are not a difference. Fails if either is.
    #[tokio::test]
    async fn a_set_is_rolled_back_when_only_a_field_the_bindings_lack_differs() {
        let mut recorded = template("db:5", "main", None);
        recorded["$patch"] = "replace".into();
        let mut running = template("db:5", "main", None);
        running["metadata"]
            .as_object_mut()
            .expect("metadata")
            .remove("creationTimestamp");
        assert_eq!(
            set_rolled_back(running.clone(), recorded.clone()).await,
            RollbackOutcome::AlreadyThere
        );
        recorded["spec"]["hostnameOverride"] = "canary".into();
        assert_eq!(
            set_rolled_back(running, recorded).await,
            RollbackOutcome::RolledBack
        );
    }

    /// "What changes" for a `StatefulSet` or `DaemonSet` compares these
    /// templates; a typed copy hid every field newer than the bindings.
    /// Fails if the wire's template goes through them, or keeps `$patch`.
    #[tokio::test]
    async fn a_recorded_template_reaches_the_page_as_the_controller_wrote_it() {
        let mut recorded = template("db:5", "main", None);
        recorded["$patch"] = "replace".into();
        let state = a_set(template("db:6", "main", None), recorded).await;
        let revisions = controller_revisions(
            &state,
            "StatefulSet".into(),
            "db".into(),
            Some("shop".into()),
        )
        .await
        .expect("revisions");
        assert!(revisions[0].template_read);
        let shown = revisions[0].template.as_ref().expect("a template");
        assert_eq!(shown["spec"]["hostnameOverride"], "main");
        assert_eq!(
            shown["spec"]["containers"][0]["env"][0]["valueFrom"]["fileKeyRef"]["key"],
            "k"
        );
        assert_eq!(shown.get("$patch"), None);
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
