//! The revisions a `StatefulSet` or `DaemonSet` has been through, read from
//! the `ControllerRevision`s the controller keeps for it.
//!
//! A `Deployment`'s history is its `ReplicaSet`s and lives in `replicasets`;
//! the other two kinds snapshot their pod template into a `ControllerRevision`
//! instead, and that is the only record of what an older revision ran.

use k8s_openapi::api::apps::v1::{ControllerRevision, DaemonSet, StatefulSet};
use k8s_openapi::api::core::v1::PodTemplateSpec;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use kube::api::ListParams;
use kube::{Api, ResourceExt};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::resources::{DeploymentContainerInfo, OptionTimeExt, TemplateContainers};
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
    crate::validation::validate_dns_label(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;

    let (uid, update_revision, selector) = match kind.as_str() {
        "StatefulSet" => {
            let sts: StatefulSet = ctx.namespaced_api().get(&name).await?;
            let update = sts.status.as_ref().and_then(|s| s.update_revision.clone());
            let selector = sts.spec.as_ref().map(|s| &s.selector);
            (
                sts.uid().unwrap_or_default(),
                update,
                label_selector(selector),
            )
        }
        "DaemonSet" => {
            let ds: DaemonSet = ctx.namespaced_api().get(&name).await?;
            let selector = ds.spec.as_ref().map(|s| &s.selector);
            (ds.uid().unwrap_or_default(), None, label_selector(selector))
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
    let list = api.list(&params).await?;
    let owned: Vec<&ControllerRevision> = list
        .items
        .iter()
        .filter(|cr| {
            cr.owner_references()
                .iter()
                .any(|owner| owner.uid == uid && owner.controller.unwrap_or(false))
        })
        .collect();
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
                created_at: cr.metadata.creation_timestamp.as_ref().to_rfc3339_opt(),
            }
        })
        .collect();
    revisions.sort_by_key(|r| std::cmp::Reverse(r.revision));
    Ok(revisions)
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
