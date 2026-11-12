//! Storage-related Tauri commands
//!
//! Commands for managing `PersistentVolumes`, `PersistentVolumeClaims`, and `StorageClasses`.

use crate::error::Result;
use crate::resources::{PersistentVolumeClaimInfo, PersistentVolumeInfo, StorageClassInfo};
use crate::state::AppState;

use k8s_openapi::api::core::v1::{PersistentVolume, PersistentVolumeClaim};
use k8s_openapi::api::storage::v1::StorageClass;
use tauri::State;

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{
    get_cluster_resource_info, get_resource_info, list_cluster_resource_infos, list_in_scope,
};

/// List all `PersistentVolumes` in the cluster
#[tauri::command]
pub async fn list_persistent_volumes(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<PersistentVolumeInfo>> {
    crate::client::clock::timed(
        &state.perf,
        "listPersistentVolumes",
        list_cluster_resource_infos::<PersistentVolume, PersistentVolumeInfo>(
            filters,
            state.clone(),
        ),
    )
    .await
}

list_in_scope!(
    list_persistent_volume_claims_in,
    PersistentVolumeClaim,
    PersistentVolumeClaimInfo
);

/// List `StorageClasses`
#[tauri::command]
pub async fn list_storage_classes(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<StorageClassInfo>> {
    crate::client::clock::timed(
        &state.perf,
        "listStorageClasses",
        list_cluster_resource_infos::<StorageClass, StorageClassInfo>(filters, state.clone()),
    )
    .await
}

/// Get a single `PersistentVolume` by name
#[tauri::command]
pub async fn get_persistent_volume(
    name: String,
    state: State<'_, AppState>,
) -> Result<PersistentVolumeInfo> {
    crate::client::clock::timed(
        &state.perf,
        "getPersistentVolume",
        get_cluster_resource_info::<PersistentVolume, PersistentVolumeInfo>(name, state.clone()),
    )
    .await
}

/// Delete a `PersistentVolume`
#[tauri::command]
pub async fn delete_persistent_volume(name: String, state: State<'_, AppState>) -> Result<()> {
    crate::commands::helpers::delete_cluster_resource::<PersistentVolume>(name, state, None).await
}

/// Get a single `PersistentVolumeClaim` by name
#[tauri::command]
pub async fn get_persistent_volume_claim(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<PersistentVolumeClaimInfo> {
    crate::client::clock::timed(
        &state.perf,
        "getPersistentVolumeClaim",
        get_resource_info::<PersistentVolumeClaim, PersistentVolumeClaimInfo>(
            name,
            namespace,
            state.clone(),
        ),
    )
    .await
}

/// Delete a `PersistentVolumeClaim`
#[tauri::command]
pub async fn delete_persistent_volume_claim(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::delete_resource::<PersistentVolumeClaim>(name, namespace, state, None)
        .await
}

/// Get a single `StorageClass` by name
#[tauri::command]
pub async fn get_storage_class(
    name: String,
    state: State<'_, AppState>,
) -> Result<StorageClassInfo> {
    crate::client::clock::timed(
        &state.perf,
        "getStorageClass",
        get_cluster_resource_info::<StorageClass, StorageClassInfo>(name, state.clone()),
    )
    .await
}

/// Delete a `StorageClass`
#[tauri::command]
pub async fn delete_storage_class(name: String, state: State<'_, AppState>) -> Result<()> {
    crate::commands::helpers::delete_cluster_resource::<StorageClass>(name, state, None).await
}
