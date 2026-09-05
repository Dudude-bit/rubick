//! Workload resource commands (`StatefulSets`, `DaemonSets`, Jobs, `CronJobs`)

use crate::error::Result;
use crate::resources::{
    CronJobDetailInfo, CronJobInfo, DaemonSetDetailInfo, DaemonSetInfo, JobDetailInfo, JobInfo,
    StatefulSetDetailInfo, StatefulSetInfo,
};
use crate::state::AppState;
use k8s_openapi::api::apps::v1::{DaemonSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use tauri::State;

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{get_resource_info, list_resource_infos};

// ============= StatefulSet =============

#[tauri::command]
pub async fn list_statefulsets(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<StatefulSetInfo>> {
    list_resource_infos::<StatefulSet, StatefulSetInfo>(filters, state).await
}

#[tauri::command]
pub async fn get_statefulset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<StatefulSetDetailInfo> {
    crate::validation::validate_dns_label(&name)?;
    get_resource_info::<StatefulSet, StatefulSetDetailInfo>(name, namespace, state).await
}

/// Scale a `StatefulSet`
#[tauri::command]
pub async fn scale_statefulset(
    name: String,
    replicas: i32,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&name)?;
    crate::commands::helpers::scale_resource::<StatefulSet>(name, replicas, namespace, state).await
}

#[tauri::command]
pub async fn delete_statefulset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&name)?;
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

#[tauri::command]
pub async fn get_daemonset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<DaemonSetDetailInfo> {
    crate::validation::validate_dns_label(&name)?;
    get_resource_info::<DaemonSet, DaemonSetDetailInfo>(name, namespace, state).await
}

#[tauri::command]
pub async fn delete_daemonset(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&name)?;
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

#[tauri::command]
pub async fn get_job(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<JobDetailInfo> {
    crate::validation::validate_dns_label(&name)?;
    get_resource_info::<Job, JobDetailInfo>(name, namespace, state).await
}

#[tauri::command]
pub async fn delete_job(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&name)?;
    crate::commands::helpers::delete_resource::<Job>(name, namespace, state, None).await
}

// ============= CronJob =============

#[tauri::command]
pub async fn list_cronjobs(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<CronJobInfo>> {
    list_resource_infos::<CronJob, CronJobInfo>(filters, state).await
}

#[tauri::command]
pub async fn get_cronjob(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<CronJobDetailInfo> {
    crate::validation::validate_dns_label(&name)?;
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

    crate::validation::validate_dns_label(&name)?;
    crate::validation::validate_dns_label(&job_name)?;

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
    crate::validation::validate_dns_label(&name)?;
    crate::commands::helpers::delete_resource::<CronJob>(name, namespace, state, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::batch::v1::{CronJobSpec, JobSpec, JobTemplateSpec};
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
