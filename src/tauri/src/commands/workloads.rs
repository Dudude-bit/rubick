//! Workload resource commands (`StatefulSets`, `DaemonSets`, Jobs, `CronJobs`)

use crate::error::Result;
use crate::resources::{
    with_pods, CronJobDetailInfo, CronJobInfo, DaemonSetDetailInfo, DaemonSetInfo, JobDetailInfo,
    JobInfo, Rollout, Selector, StatefulSetDetailInfo, StatefulSetInfo,
};
use crate::state::AppState;
use k8s_openapi::api::apps::v1::{DaemonSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use kube::api::ListParams;
use kube::ResourceExt;
use tauri::State;

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{
    get_resource_info, list_in_scope, list_resource_infos, ResourceContext,
};

/// A set's verdict with its own pods asked, where its counts alone say it is
/// short: the counts cannot tell a pod still starting from one that never
/// will. A pod list the cluster refuses leaves the verdict as the counts read it.
async fn with_own_pods(
    ctx: &ResourceContext,
    rollout: Rollout,
    set: &ObjectMeta,
    selector: Option<&LabelSelector>,
) -> Rollout {
    if !matches!(rollout, Rollout::Short { .. }) {
        return rollout;
    }
    let Some(query) = Selector::Query(selector).query_text() else {
        return rollout;
    };
    let Ok(pods) = ctx
        .namespaced_api::<Pod>()
        .list(&ListParams::default().labels(&query))
        .await
    else {
        return rollout;
    };
    let own = pods.items.iter().filter(|pod| {
        pod.owner_references()
            .iter()
            .any(|o| o.controller == Some(true) && set.uid.as_deref() == Some(o.uid.as_str()))
    });
    with_pods(rollout, own, chrono::Utc::now())
}

async fn statefulset_detail(
    state: &AppState,
    name: String,
    namespace: Option<String>,
) -> Result<StatefulSetDetailInfo> {
    crate::validation::validate_name::<StatefulSet>(&name)?;
    let ctx = ResourceContext::for_command(state, namespace)?;
    let set: StatefulSet = ctx.namespaced_api().get(&name).await?;
    let mut info = StatefulSetDetailInfo::from(&set);
    let selector = set.spec.as_ref().map(|s| &s.selector);
    info.rollout = with_own_pods(&ctx, info.rollout, &set.metadata, selector).await;
    Ok(info)
}

async fn daemonset_detail(
    state: &AppState,
    name: String,
    namespace: Option<String>,
) -> Result<DaemonSetDetailInfo> {
    crate::validation::validate_name::<DaemonSet>(&name)?;
    let ctx = ResourceContext::for_command(state, namespace)?;
    let set: DaemonSet = ctx.namespaced_api().get(&name).await?;
    let mut info = DaemonSetDetailInfo::from(&set);
    let selector = set.spec.as_ref().map(|s| &s.selector);
    info.rollout = with_own_pods(&ctx, info.rollout, &set.metadata, selector).await;
    Ok(info)
}

// ============= StatefulSet =============

#[tauri::command]
pub async fn list_statefulsets(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<StatefulSetInfo>> {
    list_resource_infos::<StatefulSet, StatefulSetInfo>(filters, state).await
}

list_in_scope!(list_statefulsets_in, StatefulSet, StatefulSetInfo);

#[tauri::command]
pub async fn get_statefulset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<StatefulSetDetailInfo> {
    statefulset_detail(&state, name, namespace).await
}

/// Scale a `StatefulSet`
#[tauri::command]
pub async fn scale_statefulset(
    name: String,
    replicas: i32,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::scale_resource::<StatefulSet>(name, replicas, namespace, state).await
}

/// Restart a `StatefulSet` (rolling restart)
#[tauri::command]
pub async fn restart_statefulset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::restart_resource::<StatefulSet>(name, namespace, state).await
}

#[tauri::command]
pub async fn delete_statefulset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::delete_resource::<StatefulSet>(name, namespace, state, None).await
}

// ============= DaemonSet =============

#[tauri::command]
pub async fn list_daemonsets(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<DaemonSetInfo>> {
    list_resource_infos::<DaemonSet, DaemonSetInfo>(filters, state).await
}

list_in_scope!(list_daemonsets_in, DaemonSet, DaemonSetInfo);

#[tauri::command]
pub async fn get_daemonset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<DaemonSetDetailInfo> {
    daemonset_detail(&state, name, namespace).await
}

/// Restart a `DaemonSet` (rolling restart)
#[tauri::command]
pub async fn restart_daemonset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::restart_resource::<DaemonSet>(name, namespace, state).await
}

#[tauri::command]
pub async fn delete_daemonset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::delete_resource::<DaemonSet>(name, namespace, state, None).await
}

// ============= Job =============

#[tauri::command]
pub async fn list_jobs(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<JobInfo>> {
    list_resource_infos::<Job, JobInfo>(filters, state).await
}

list_in_scope!(list_jobs_in, Job, JobInfo);

#[tauri::command]
pub async fn get_job(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<JobDetailInfo> {
    get_resource_info::<Job, JobDetailInfo>(name, namespace, state).await
}

#[tauri::command]
pub async fn delete_job(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::delete_resource::<Job>(name, namespace, state, Some(job_deletion()))
        .await
}

/// batch/v1 orphans a Job's pods unless told otherwise; kubectl and the
/// cascade preview both take them with it.
fn job_deletion() -> kube::api::DeleteParams {
    kube::api::DeleteParams::background()
}

// ============= CronJob =============

list_in_scope!(list_cronjobs_in, CronJob, CronJobInfo);

#[tauri::command]
pub async fn get_cronjob(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<CronJobDetailInfo> {
    get_resource_info::<CronJob, CronJobDetailInfo>(name, namespace, state).await
}

/// Run a `CronJob` now, the way `kubectl create job --from` does.
///
/// A `CronJob` has no "run" verb — nothing asks the controller to create a
/// `Job` early — so this copies the `jobTemplate` into a new `Job` and lets
/// the normal controller take it from there.
///
/// The name is the caller's, not generated: a name a person chose is one they
/// can find again in a list of forty, and the dialog offers `kubectl`'s
/// timestamped default. The `ownerReference` is deliberate; without it the
/// `Job` outlives its `CronJob` and never counts against
/// `successfulJobsHistoryLimit`, so pressing this weekly accumulates `Job`s
/// nothing will collect.
#[tauri::command]
pub async fn trigger_cronjob(
    name: String,
    job_name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    use kube::api::PostParams;
    use kube::ResourceExt;

    crate::validation::validate_name::<CronJob>(&name)?;
    crate::validation::validate_name::<Job>(&job_name)?;

    let ctx = crate::commands::helpers::ResourceContext::for_command(&state, namespace)?;
    let cronjobs: kube::Api<CronJob> = ctx.namespaced_api();
    let cronjob = cronjobs.get(&name).await?;

    let job = job_from_cronjob(&cronjob, &job_name)?;
    let jobs: kube::Api<Job> = ctx.namespaced_api();
    let created = jobs.create(&PostParams::default(), &job).await?;
    Ok(created.name_any())
}

/// The `Job` a `CronJob` would have made, named by the reader.
///
/// Split from the command so the decision can be checked without a cluster:
/// what the controller does with the object is Kubernetes' business, but
/// what we hand it is ours.
fn job_from_cronjob(cronjob: &CronJob, job_name: &str) -> Result<Job> {
    use kube::api::ObjectMeta;
    use kube::ResourceExt;

    let name = cronjob.name_any();
    let template = cronjob
        .spec
        .as_ref()
        .map(|spec| spec.job_template.clone())
        .ok_or_else(|| {
            crate::error::Error::InvalidInput(format!("CronJob {name} has no jobTemplate"))
        })?;

    let job_spec = template.spec.ok_or_else(|| {
        crate::error::Error::InvalidInput(format!("CronJob {name}'s jobTemplate has no spec"))
    })?;

    // The template's own labels and annotations come along: a `Job` a team's
    // selectors cannot see is one nobody will find.
    let mut meta = template.metadata.unwrap_or_default();
    meta.name = Some(job_name.to_string());
    meta.namespace = cronjob.namespace();
    meta.owner_references = Some(vec![
        k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference {
            api_version: "batch/v1".to_string(),
            kind: "CronJob".to_string(),
            name,
            uid: cronjob.uid().unwrap_or_default(),
            block_owner_deletion: Some(true),
            controller: Some(true),
        },
    ]);

    Ok(Job {
        metadata: ObjectMeta { ..meta },
        spec: Some(job_spec),
        status: None,
    })
}

#[tauri::command]
pub async fn delete_cronjob(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::delete_resource::<CronJob>(name, namespace, state, None).await
}

#[cfg(test)]
mod set_detail_tests {
    use super::*;
    use crate::client::served::{
        test_server::{connected, failure},
        ServedIndex,
    };

    fn pod(name: &str, owner: &str, ready: bool, waiting: &str) -> serde_json::Value {
        serde_json::json!({
            "metadata": {
                "name": name,
                "namespace": "shop",
                "creationTimestamp": (chrono::Utc::now() - chrono::Duration::seconds(5)).to_rfc3339(),
                "ownerReferences": [{
                    "apiVersion": "apps/v1", "kind": "StatefulSet",
                    "name": owner, "uid": owner, "controller": true,
                }],
            },
            "status": {
                "phase": if ready { "Running" } else { "Pending" },
                "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }],
                "containerStatuses": [{
                    "name": "app", "image": "app", "imageID": "", "ready": ready, "restartCount": 0,
                    "state": if ready { serde_json::json!({ "running": {} }) }
                             else { serde_json::json!({ "waiting": { "reason": waiting } }) },
                }],
            },
        })
    }

    fn stateful_set() -> String {
        serde_json::json!({
            "apiVersion": "apps/v1", "kind": "StatefulSet",
            "metadata": { "name": "web", "namespace": "shop", "uid": "web", "generation": 2 },
            "spec": {
                "replicas": 2, "serviceName": "web",
                "selector": { "matchLabels": { "app": "web" } }, "template": {},
            },
            "status": {
                "observedGeneration": 2, "replicas": 2, "readyReplicas": 1,
                "availableReplicas": 1, "updatedReplicas": 2,
                "currentRevision": "web-1", "updateRevision": "web-1",
            },
        })
        .to_string()
    }

    fn daemon_set() -> String {
        serde_json::json!({
            "apiVersion": "apps/v1", "kind": "DaemonSet",
            "metadata": { "name": "agent", "namespace": "shop", "uid": "agent", "generation": 1 },
            "spec": { "selector": { "matchLabels": { "app": "agent" } }, "template": {} },
            "status": {
                "observedGeneration": 1, "desiredNumberScheduled": 2,
                "currentNumberScheduled": 2, "updatedNumberScheduled": 2,
                "numberMisscheduled": 0, "numberReady": 1, "numberAvailable": 1,
            },
        })
        .to_string()
    }

    /// A cluster where each set's second pod waits as `new_pod` says, or
    /// where the pod list is refused when `new_pod` is empty.
    async fn read(new_pod: &'static str) -> (Rollout, Rollout) {
        let (state, _) = connected(ServedIndex::default(), move |path, _| match path {
            "/apis/apps/v1/namespaces/shop/statefulsets/web" => (200, stateful_set()),
            "/apis/apps/v1/namespaces/shop/daemonsets/agent" => (200, daemon_set()),
            "/api/v1/namespaces/shop/pods" if new_pod.is_empty() => failure(403, "Forbidden"),
            "/api/v1/namespaces/shop/pods" => (
                200,
                serde_json::json!({
                    "apiVersion": "v1", "kind": "PodList", "metadata": {},
                    "items": [
                        pod("web-0", "web", true, ""),
                        pod("web-1", "web", false, new_pod),
                        pod("agent-a", "agent", true, ""),
                        pod("agent-b", "agent", false, new_pod),
                    ],
                })
                .to_string(),
            ),
            _ => (404, "{}".into()),
        })
        .await;
        let set = statefulset_detail(&state, "web".into(), Some("shop".into()))
            .await
            .expect("the StatefulSet");
        let daemon = daemonset_detail(&state, "agent".into(), Some("shop".into()))
            .await
            .expect("the DaemonSet");
        (set.rollout, daemon.rollout)
    }

    /// The page, the peek and Share read a set's verdict from here, and a
    /// scale whose new pod was being created read amber Degraded. Fails if
    /// the set's own pods are not asked, if a stuck one is let off, or if a
    /// refused pod list is taken for pods coming up.
    #[tokio::test]
    async fn a_set_scaling_up_reads_coming_up_only_while_its_new_pod_is_starting() {
        let coming = Rollout::ComingUp {
            available: 1,
            desired: 2,
        };
        let short = Rollout::Short {
            available: 1,
            desired: 2,
        };
        assert_eq!(read("ContainerCreating").await, (coming.clone(), coming));
        assert_eq!(
            read("ImagePullBackOff").await,
            (short.clone(), short.clone())
        );
        assert_eq!(read("").await, (short.clone(), short));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::batch::v1::{CronJobSpec, JobSpec, JobTemplateSpec};

    /// Without a policy the API server keeps a deleted Job's pods, while the
    /// dialog said they go with it.
    #[test]
    fn deleting_a_job_takes_its_pods() {
        assert_eq!(
            job_deletion().propagation_policy,
            Some(kube::api::PropagationPolicy::Background)
        );
    }
    use kube::api::ObjectMeta;
    use std::collections::BTreeMap;

    fn cronjob(template_meta: Option<ObjectMeta>) -> CronJob {
        CronJob {
            metadata: ObjectMeta {
                name: Some("nightly".to_string()),
                namespace: Some("batch".to_string()),
                uid: Some("cj-uid-1".to_string()),
                ..Default::default()
            },
            spec: Some(CronJobSpec {
                schedule: "0 3 * * *".to_string(),
                job_template: JobTemplateSpec {
                    metadata: template_meta,
                    spec: Some(JobSpec::default()),
                },
                ..Default::default()
            }),
            status: None,
        }
    }

    /// A `Job` created by hand that a team's selectors cannot see is a `Job`
    /// nobody will find, so the template's own labels come along — the
    /// scheduled runs carry them and a manual one that did not would sort
    /// differently in every dashboard the team has.
    #[test]
    fn the_run_carries_the_labels_the_schedule_would_have_given_it() {
        let mut labels = BTreeMap::new();
        labels.insert("team".to_string(), "billing".to_string());
        let job = job_from_cronjob(
            &cronjob(Some(ObjectMeta {
                labels: Some(labels),
                ..Default::default()
            })),
            "nightly-1756000000",
        )
        .expect("builds");

        assert_eq!(job.metadata.name.as_deref(), Some("nightly-1756000000"));
        assert_eq!(job.metadata.namespace.as_deref(), Some("batch"));
        assert_eq!(
            job.metadata
                .labels
                .as_ref()
                .and_then(|l| l.get("team"))
                .map(String::as_str),
            Some("billing")
        );
    }

    /// Without the ownerReference the `Job` outlives its `CronJob` and is never
    /// counted against `successfulJobsHistoryLimit`, so a cluster where
    /// somebody presses this weekly accumulates `Job`s nothing will collect.
    /// `kubectl create job --from` sets it for the same reason.
    #[test]
    fn the_run_is_owned_by_the_cronjob_that_made_it() {
        let job = job_from_cronjob(&cronjob(None), "nightly-1").expect("builds");
        let owner = job
            .metadata
            .owner_references
            .as_ref()
            .and_then(|refs| refs.first())
            .expect("an owner");

        assert_eq!(owner.kind, "CronJob");
        assert_eq!(owner.name, "nightly");
        assert_eq!(owner.uid, "cj-uid-1");
        assert_eq!(owner.controller, Some(true));
        assert_eq!(owner.block_owner_deletion, Some(true));
    }

    /// A `CronJob` with no template is not a `CronJob` this can run, and saying
    /// which one is missing beats a 422 from the API server.
    #[test]
    fn a_cronjob_with_no_template_spec_says_so_before_the_api_does() {
        let mut empty = cronjob(None);
        empty.spec.as_mut().expect("spec").job_template.spec = None;

        let err = job_from_cronjob(&empty, "nightly-1").expect_err("no spec");
        assert!(
            err.to_string().contains("jobTemplate"),
            "the message must name what is missing: {err}"
        );
    }
}
