//! Tauri commands operating on instances (custom resources) of a CRD.
//!
//! Each command does the same dance — load the CRD, find storage
//! version, build a `kube::discovery::ApiResource`, then wrap a
//! dynamic Api around it. `crd_to_dynamic_api` collapses that into
//! a single helper.

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, DeleteParams, DynamicObject};
use kube::discovery::ApiResource;
use tauri::State;

use crate::commands::helpers::{build_list_params, ResourceContext};
use crate::error::{Error, Result};
use crate::state::AppState;

use super::convert::{dynamic_object_to_custom_resource_info, dynamic_object_to_detail_info};
use super::types::{CustomResourceDetailInfo, CustomResourceInfo};

/// Load the CRD by name and return a dynamic `Api<DynamicObject>`
/// scoped to its storage version. Used by every instance command.
///
/// `listing` is the difference between the two kinds of caller: a list
/// with no namespace means every namespace, while a get or a delete with
/// none means the default one. Collapsing both onto `for_command` narrowed
/// every unscoped list to `default`, and the answer that came back — none
/// of them, on a cluster full of them — looked exactly like a true one.
async fn crd_to_dynamic_api(
    crd_name: &str,
    namespace: Option<String>,
    listing: bool,
    state: &State<'_, AppState>,
) -> Result<Api<DynamicObject>> {
    let crd: CustomResourceDefinition =
        crate::commands::helpers::get_cluster_resource(crd_name.to_string(), state.clone()).await?;

    let spec = &crd.spec;
    let version = spec.versions.iter().find(|v| v.storage).map_or_else(
        || {
            spec.versions
                .first()
                .map(|v| v.name.clone())
                .unwrap_or_default()
        },
        |v| v.name.clone(),
    );

    let api_version = if spec.group.is_empty() {
        version.clone()
    } else {
        format!("{}/{}", spec.group, version)
    };

    let api_resource = ApiResource {
        group: spec.group.clone(),
        version,
        kind: spec.names.kind.clone(),
        api_version,
        plural: spec.names.plural.clone(),
    };

    let is_namespaced = spec.scope == "Namespaced";

    let ctx = if !is_namespaced {
        ResourceContext::for_list(state, None)?
    } else if listing {
        ResourceContext::for_list(state, namespace)?
    } else {
        ResourceContext::for_command(state, namespace)?
    };

    Ok(ctx.dynamic_api_for_resource(&api_resource, !is_namespaced))
}

/// List custom resource instances for a specific CRD
#[tauri::command]
pub async fn list_custom_resources(
    crd_name: String,
    namespace: Option<String>,
    label_selector: Option<String>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<CustomResourceInfo>> {
    crate::validation::validate_dns_subdomain(&crd_name)?;

    let api = crd_to_dynamic_api(&crd_name, namespace, true, &state).await?;
    let params = build_list_params(label_selector.as_deref(), None, limit);
    let list = api.list(&params).await?;

    Ok(list
        .items
        .iter()
        .map(dynamic_object_to_custom_resource_info)
        .collect())
}

/// Get a single custom resource instance
#[tauri::command]
pub async fn get_custom_resource(
    crd_name: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<CustomResourceDetailInfo> {
    crate::validation::validate_dns_subdomain(&crd_name)?;
    crate::validation::validate_dns_subdomain(&name)?;

    let api = crd_to_dynamic_api(&crd_name, namespace, false, &state).await?;
    let obj = api.get(&name).await?;

    Ok(dynamic_object_to_detail_info(&obj))
}

/// Get custom resource YAML
#[tauri::command]
pub async fn get_custom_resource_yaml(
    crd_name: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_dns_subdomain(&crd_name)?;
    crate::validation::validate_dns_subdomain(&name)?;

    let api = crd_to_dynamic_api(&crd_name, namespace, false, &state).await?;
    let obj = api.get(&name).await?;

    let yaml = serde_yaml::to_string(&obj).map_err(|e| Error::Serialization(e.to_string()))?;
    crate::commands::helpers::clean_yaml_for_editor(&yaml)
}

/// Delete a custom resource instance
#[tauri::command]
pub async fn delete_custom_resource(
    crd_name: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&crd_name)?;
    crate::validation::validate_dns_subdomain(&name)?;

    let api = crd_to_dynamic_api(&crd_name, namespace, false, &state).await?;
    api.delete(&name, &DeleteParams::default()).await?;

    Ok(())
}
