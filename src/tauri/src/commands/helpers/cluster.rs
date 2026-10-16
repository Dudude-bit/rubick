//! Generic helpers for cluster-scoped Kubernetes resources —
//! get / delete / list / list-into-Info / get-into-Info.

use crate::commands::filters::ResourceFilters;
use crate::error::{Error, Result};
use crate::state::AppState;
use kube::api::DeleteParams;
use tauri::State;

use super::context::ResourceContext;
use super::params::build_list_params;

/// Get a single cluster-scoped resource
pub async fn get_cluster_resource<K>(name: String, state: State<'_, AppState>) -> Result<K>
where
    K: kube::Resource<Scope = k8s_openapi::ClusterResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
{
    crate::validation::validate_name::<K>(&name)?;
    let ctx = ResourceContext::for_list(&state, None)?;
    ctx.cluster_api::<K>().get(&name).await.map_err(Error::from)
}

/// Delete a cluster-scoped resource
pub async fn delete_cluster_resource<K>(
    name: String,
    state: State<'_, AppState>,
    delete_params: Option<DeleteParams>,
) -> Result<()>
where
    K: kube::Resource<Scope = k8s_openapi::ClusterResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
{
    crate::validation::validate_name::<K>(&name)?;
    let ctx = ResourceContext::for_list(&state, None)?;
    let params = delete_params.unwrap_or_default();
    ctx.cluster_api::<K>().delete(&name, &params).await?;
    Ok(())
}

/// List cluster-scoped resources with common filters
pub async fn list_cluster_resources<K>(
    state: State<'_, AppState>,
    label_selector: Option<&str>,
    field_selector: Option<&str>,
    limit: Option<i64>,
) -> Result<kube::core::ObjectList<K>>
where
    K: kube::Resource<Scope = k8s_openapi::ClusterResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
{
    let ctx = ResourceContext::for_list(&state, None)?;
    let params = build_list_params(label_selector, field_selector, limit);
    ctx.cluster_api::<K>()
        .list(&params)
        .await
        .map_err(Error::from)
}

/// List cluster-scoped resources and map into info types.
pub async fn list_cluster_resource_infos<K, Info>(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<Info>>
where
    K: kube::Resource<Scope = k8s_openapi::ClusterResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
    Info: for<'a> From<&'a K>,
{
    let filters = filters.unwrap_or_default();
    let list = list_cluster_resources::<K>(
        state,
        filters.label_selector.as_deref(),
        filters.field_selector.as_deref(),
        filters.limit,
    )
    .await?;

    Ok(list.items.iter().map(Info::from).collect())
}

/// Get a cluster-scoped resource and map into an info type.
pub async fn get_cluster_resource_info<K, Info>(
    name: String,
    state: State<'_, AppState>,
) -> Result<Info>
where
    K: kube::Resource<Scope = k8s_openapi::ClusterResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
    Info: for<'a> From<&'a K>,
{
    let resource: K = get_cluster_resource(name, state).await?;
    Ok(Info::from(&resource))
}
