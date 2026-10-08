//! Deployment-specific commands

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{list_in_scope, list_resource_infos, ResourceContext};
use crate::error::Result;
use crate::resources::{DeploymentInfo, PodInfo};
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

list_in_scope!(list_deployments_in, Deployment, DeploymentInfo);

async fn deployment_detail(
    state: &AppState,
    name: String,
    namespace: Option<String>,
) -> Result<DeploymentInfo> {
    crate::validation::validate_name::<Deployment>(&name)?;
    let ctx = ResourceContext::for_command(state, namespace)?;
    let deployment: Deployment = ctx.namespaced_api().get(&name).await?;
    let mut info = DeploymentInfo::from(&deployment);
    let selector = deployment.spec.as_ref().map(|s| &s.selector);
    info.rollout = crate::commands::workloads::with_own_pods(
        &ctx,
        info.rollout,
        "Deployment",
        &deployment.metadata,
        selector,
    )
    .await;
    Ok(info)
}

/// Get a single deployment by name
#[tauri::command]
pub async fn get_deployment(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<DeploymentInfo> {
    deployment_detail(&state, name, namespace).await
}

/// Delete a deployment
#[tauri::command]
pub async fn delete_deployment(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
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
    crate::commands::helpers::scale_resource::<Deployment>(name, replicas, namespace, state).await
}

/// Restart a deployment (rolling restart)
#[tauri::command]
pub async fn restart_deployment(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::restart_resource::<Deployment>(name, namespace, state).await
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

#[cfg(test)]
mod detail_tests {
    use super::*;
    use crate::client::served::{
        test_server::{connected, failure},
        ServedIndex,
    };
    use crate::resources::Rollout;

    fn pod(name: &str, replica_set: &str, ready: bool, waiting: &str) -> serde_json::Value {
        let hash = replica_set.rsplit('-').next().unwrap_or_default();
        serde_json::json!({
            "metadata": {
                "name": name,
                "namespace": "shop",
                "labels": { "app": "cart", "pod-template-hash": hash },
                "creationTimestamp": (chrono::Utc::now() - chrono::Duration::seconds(2)).to_rfc3339(),
                "ownerReferences": [{
                    "apiVersion": "apps/v1", "kind": "ReplicaSet",
                    "name": replica_set, "uid": replica_set, "controller": true,
                }],
            },
            "status": {
                "phase": if ready { "Running" } else { "Pending" },
                "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }],
                "containerStatuses": [{
                    "name": "cart", "image": "cart", "imageID": "", "ready": ready, "restartCount": 0,
                    "state": if ready { serde_json::json!({ "running": {} }) }
                             else { serde_json::json!({ "waiting": { "reason": waiting } }) },
                }],
            },
        })
    }

    /// `cart` the second after Dana scaled it from 3 to 4, as kubectl printed it.
    fn cart() -> String {
        serde_json::json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": "cart", "namespace": "shop", "uid": "cart", "generation": 3 },
            "spec": {
                "replicas": 4,
                "selector": { "matchLabels": { "app": "cart" } },
                "template": { "metadata": { "labels": { "app": "cart" } } },
            },
            "status": {
                "observedGeneration": 3, "replicas": 4, "updatedReplicas": 4,
                "readyReplicas": 3, "availableReplicas": 3, "unavailableReplicas": 1,
                "conditions": [
                    {
                        "type": "Available", "status": "True",
                        "reason": "MinimumReplicasAvailable",
                        "message": "Deployment has minimum availability.",
                    },
                    {
                        "type": "Progressing", "status": "True",
                        "reason": "NewReplicaSetAvailable",
                        "message": "ReplicaSet \"cart-9df89489c\" has successfully progressed.",
                    },
                ],
            },
        })
        .to_string()
    }

    /// The page, the peek and Share of `cart` with its fourth pod waiting as
    /// `new_pod` says, or with the pod list refused when `new_pod` is empty.
    /// A failing pod of `cart-legacy`, which shares the label, is always there.
    async fn read(new_pod: &'static str) -> Rollout {
        let (state, _) = connected(ServedIndex::default(), move |path, _| match path {
            "/apis/apps/v1/namespaces/shop/deployments/cart" => (200, cart()),
            "/api/v1/namespaces/shop/pods" if new_pod.is_empty() => failure(403, "Forbidden"),
            "/api/v1/namespaces/shop/pods" => (
                200,
                serde_json::json!({
                    "apiVersion": "v1", "kind": "PodList", "metadata": {},
                    "items": [
                        pod("cart-9df89489c-a1", "cart-9df89489c", true, ""),
                        pod("cart-9df89489c-b2", "cart-9df89489c", true, ""),
                        pod("cart-9df89489c-c3", "cart-9df89489c", true, ""),
                        pod("cart-9df89489c-d4", "cart-9df89489c", false, new_pod),
                        pod("cart-legacy-7f9c4-e5", "cart-legacy-7f9c4", false, "CrashLoopBackOff"),
                    ],
                })
                .to_string(),
            ),
            _ => (404, "{}".into()),
        })
        .await;
        deployment_detail(&state, "cart".into(), Some("shop".into()))
            .await
            .expect("the Deployment")
            .rollout
    }

    /// Dana's scale read amber Degraded on the page while the fourth pod was
    /// being created. Fails if the Deployment's own pods are not asked, if a
    /// stuck one is let off, or if another Deployment's pod is counted.
    #[tokio::test]
    async fn a_deployment_scaling_up_reads_coming_up_only_while_its_new_pod_is_starting() {
        assert_eq!(
            read("ContainerCreating").await,
            Rollout::ComingUp {
                available: 3,
                desired: 4
            }
        );
        let short = Rollout::Short {
            available: 3,
            desired: 4,
        };
        assert_eq!(read("ImagePullBackOff").await, short);
    }

    /// The page fell back on the counts in silence when the pod list was
    /// refused, and drew them as confidently as a verdict its pods had
    /// confirmed. Fails if a refused read is taken for pods that were read.
    #[tokio::test]
    async fn a_refused_pod_list_leaves_the_deployment_the_controllers_verdict_alone() {
        assert_eq!(
            read("").await,
            Rollout::PodsUnread {
                controller: Box::new(Rollout::Short {
                    available: 3,
                    desired: 4,
                }),
            }
        );
    }
}
