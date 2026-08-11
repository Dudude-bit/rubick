//! Generic helpers for namespaced Kubernetes resources —
//! get / delete / list / list-into-Info / get-into-Info.

use crate::commands::filters::ResourceFilters;
use crate::error::{Error, Result};
use crate::state::AppState;
use kube::api::{DeleteParams, Patch, PatchParams};
use tauri::State;

use super::context::ResourceContext;
use super::params::build_list_params;

/// Get a single namespaced resource
pub async fn get_resource<K>(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<K>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
{
    let ctx = ResourceContext::for_command(&state, namespace)?;
    ctx.namespaced_api::<K>()
        .get(&name)
        .await
        .map_err(Error::from)
}

/// Delete a namespaced resource
pub async fn delete_resource<K>(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
    delete_params: Option<DeleteParams>,
) -> Result<()>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
{
    let ctx = ResourceContext::for_command(&state, namespace)?;
    let params = delete_params.unwrap_or_default();
    ctx.namespaced_api::<K>().delete(&name, &params).await?;
    Ok(())
}

/// Set a namespaced workload's replica count.
///
/// A merge patch on `spec.replicas` rather than the `scale` subresource: the
/// two reach the same field, and the plain patch is the one every other write
/// in this app already uses, so a refusal comes back shaped like every other
/// refusal instead of as a subresource error the frontend has never seen.
pub async fn scale_resource<K>(
    name: String,
    replicas: i32,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
{
    let ctx = ResourceContext::for_command(&state, namespace)?;
    let patch = serde_json::json!({ "spec": { "replicas": replicas } });
    ctx.namespaced_api::<K>()
        .patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// List namespaced resources with common filters
pub async fn list_resources<K>(
    namespace: Option<String>,
    state: State<'_, AppState>,
    label_selector: Option<&str>,
    field_selector: Option<&str>,
    limit: Option<i64>,
) -> Result<kube::core::ObjectList<K>>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
{
    let ctx = ResourceContext::for_list(&state, namespace)?;
    let params = build_list_params(label_selector, field_selector, limit);
    ctx.namespaced_or_cluster_api::<K>()
        .list(&params)
        .await
        .map_err(Error::from)
}

/// List namespaced resources and map into info types.
pub async fn list_resource_infos<K, Info>(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<Info>>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
    Info: for<'a> From<&'a K>,
{
    let filters = filters.unwrap_or_default();
    let list = list_resources::<K>(
        filters.namespace.clone(),
        state,
        filters.label_selector.as_deref(),
        filters.field_selector.as_deref(),
        filters.limit,
    )
    .await?;

    Ok(list.items.iter().map(Info::from).collect())
}

/// Get a namespaced resource and map into an info type.
pub async fn get_resource_info<K, Info>(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Info>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
    Info: for<'a> From<&'a K>,
{
    let resource: K = get_resource(name, namespace, state).await?;
    Ok(Info::from(&resource))
}
