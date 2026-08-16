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

#[tauri::command]
pub async fn delete_cronjob(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&name)?;
    crate::commands::helpers::delete_resource::<CronJob>(name, namespace, state, None).await
}
