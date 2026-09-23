//! Service-specific commands

use k8s_openapi::api::core::v1::Service;
use tauri::State;

use crate::commands::filters::ServiceFilters;
use crate::commands::helpers::{get_resource_info, list_resource_infos};
use crate::error::Result;
use crate::resources::ServiceInfo;
use crate::state::AppState;

/// List services with optional filters
#[tauri::command]
pub async fn list_services(
    filters: Option<ServiceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<ServiceInfo>> {
    let filters = filters.unwrap_or_default();
    let mut services: Vec<ServiceInfo> =
        list_resource_infos::<Service, ServiceInfo>(Some(filters.base.clone()), state).await?;

    // Apply type filter if specified
    if let Some(svc_type) = &filters.service_type {
        services.retain(|s| s.type_.eq_ignore_ascii_case(svc_type));
    }

    Ok(services)
}

/// Get a single service by name
#[tauri::command]
pub async fn get_service(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ServiceInfo> {
    get_resource_info::<Service, ServiceInfo>(name, namespace, state).await
}

/// Delete a service
#[tauri::command]
pub async fn delete_service(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::delete_resource::<Service>(name, namespace, state, None).await
}
