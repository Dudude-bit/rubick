//! Deployment-specific commands

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{get_resource_info, list_resource_infos, ResourceContext};
use crate::error::Result;
use crate::resources::{DeploymentCondition, DeploymentInfo, PodInfo, RolloutStatus};
use crate::state::AppState;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Patch, PatchParams};
use tauri::State;

/// List deployments with optional filters
#[tauri::command]
pub async fn list_deployments(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<DeploymentInfo>> {
    list_resource_infos::<Deployment, DeploymentInfo>(filters, state).await
}

/// Get a single deployment by name
#[tauri::command]
pub async fn get_deployment(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<DeploymentInfo> {
    crate::validation::validate_dns_label(&name)?;
    get_resource_info::<Deployment, DeploymentInfo>(name, namespace, state).await
}

/// Delete a deployment
#[tauri::command]
pub async fn delete_deployment(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&name)?;
    crate::commands::helpers::delete_resource::<Deployment>(name, namespace, state, None).await
}

/// Scale a deployment
#[tauri::command]
pub async fn scale_deployment(
    name: String,
    replicas: i32,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&name)?;
    crate::commands::helpers::scale_resource::<Deployment>(name, replicas, namespace, state).await
}

/// Restart a deployment (rolling restart)
#[tauri::command]
pub async fn restart_deployment(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let ctx = ResourceContext::for_command(&state, namespace)?;

    let api: kube::Api<Deployment> = ctx.namespaced_api();

    // Trigger a rolling restart by updating an annotation
    let now = chrono::Utc::now().to_rfc3339();
    let patch = serde_json::json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": now
                    }
                }
            }
        }
    });

    api.patch(&name, &PatchParams::default(), &Patch::Strategic(&patch))
        .await?;

    Ok(())
}

/// Update deployment image
#[tauri::command]
pub async fn update_deployment_image(
    name: String,
    container_name: String,
    image: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let ctx = ResourceContext::for_command(&state, namespace)?;

    let api: kube::Api<Deployment> = ctx.namespaced_api();

    let deployment = api.get(&name).await?;

    // Find and update the container image
    let mut spec = deployment
        .spec
        .ok_or_else(|| crate::error::Error::InvalidInput("Deployment has no spec".to_string()))?;
    let mut template_spec = spec
        .template
        .spec
        .ok_or_else(|| crate::error::Error::InvalidInput("Template has no spec".to_string()))?;

    let container = template_spec
        .containers
        .iter_mut()
        .find(|c| c.name == container_name)
        .ok_or_else(|| {
            crate::error::Error::InvalidInput(format!("Container '{container_name}' not found"))
        })?;

    container.image = Some(image.clone());
    spec.template.spec = Some(template_spec);

    let patch = serde_json::json!({
        "spec": spec
    });

    api.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;

    Ok(())
}

/// Get deployment pods
#[tauri::command]
pub async fn get_deployment_pods(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<PodInfo>> {
    let ctx = ResourceContext::for_command(&state, namespace)?;

    // Get the deployment to find its label selector
    let deploy_api: kube::Api<Deployment> = ctx.namespaced_api();
    let deployment = deploy_api.get(&name).await?;

    // The whole selector, so a Deployment claiming its pods by a set-based
    // requirement returns the pods the controller returns rather than none.
    let label_selector =
        crate::resources::Selector::Query(deployment.spec.as_ref().map(|s| &s.selector))
            .query_text()
            .ok_or_else(|| {
                crate::error::Error::InvalidInput("Deployment has no selector".to_string())
            })?;

    // Get pods matching the selector
    let pod_api: kube::Api<Pod> = ctx.namespaced_api();
    let params = kube::api::ListParams::default().labels(&label_selector);
    let pods = pod_api.list(&params).await?;

    let pod_infos: Vec<PodInfo> = pods.items.iter().map(PodInfo::from).collect();

    Ok(pod_infos)
}

/// Get deployment rollout status
#[tauri::command]
pub async fn get_rollout_status(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<RolloutStatus> {
    let ctx = ResourceContext::for_command(&state, namespace)?;

    let api: kube::Api<Deployment> = ctx.namespaced_api();
    let deployment = api.get(&name).await?;

    let status = deployment
        .status
        .ok_or_else(|| crate::error::Error::InvalidInput("Deployment has no status".to_string()))?;

    let conditions: Vec<DeploymentCondition> = status
        .conditions
        .unwrap_or_default()
        .into_iter()
        .map(|c| DeploymentCondition {
            condition_type: c.type_,
            status: c.status,
            reason: c.reason,
            message: c.message,
        })
        .collect();

    Ok(RolloutStatus {
        replicas: status.replicas.unwrap_or(0),
        ready_replicas: status.ready_replicas.unwrap_or(0),
        updated_replicas: status.updated_replicas.unwrap_or(0),
        available_replicas: status.available_replicas.unwrap_or(0),
        conditions,
    })
}
