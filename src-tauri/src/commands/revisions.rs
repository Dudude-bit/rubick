//! The revisions a `StatefulSet` or `DaemonSet` has been through, read from
//! the `ControllerRevision`s the controller keeps for it.
//!
//! A `Deployment`'s history is its `ReplicaSet`s and lives in `replicasets`;
//! the other two kinds snapshot their pod template into a `ControllerRevision`
//! instead, and that is the only record of what an older revision ran.

use k8s_openapi::api::apps::v1::{ControllerRevision, DaemonSet, StatefulSet};
use k8s_openapi::api::core::v1::PodTemplateSpec;
use kube::api::ListParams;
use kube::{Api, ResourceExt};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::resources::{DeploymentContainerInfo, OptionTimeExt, TemplateContainers};
use crate::state::AppState;

/// `kubectl rollout history` reads the cause from the template's annotations.
const CHANGE_CAUSE: &str = "kubernetes.io/change-cause";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerRevisionInfo {
    pub name: String,
    pub revision: i64,
    /// The revision the controller is rolling out or has rolled out.
    pub current: bool,
    pub change_cause: Option<String>,
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

    let (uid, update_revision) = match kind.as_str() {
        "StatefulSet" => {
            let sts: StatefulSet = ctx.namespaced_api().get(&name).await?;
            let update = sts.status.as_ref().and_then(|s| s.update_revision.clone());
            (sts.uid().unwrap_or_default(), update)
        }
        "DaemonSet" => {
            let ds: DaemonSet = ctx.namespaced_api().get(&name).await?;
            (ds.uid().unwrap_or_default(), None)
        }
        other => {
            return Err(Error::InvalidInput(format!(
                "{other} keeps no ControllerRevisions"
            )))
        }
    };

    let api: Api<ControllerRevision> = ctx.namespaced_api();
    let list = api.list(&ListParams::default()).await?;
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
                change_cause: annotations.get(CHANGE_CAUSE).cloned(),
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
