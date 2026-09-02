//! `ConfigMap` commands — list / get / get-data / set-key / delete.

use super::data::ConfigData;
use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{get_resource_info, list_resource_infos};
use crate::error::Result;
use crate::resources::ConfigMapInfo;
use crate::state::AppState;
use k8s_openapi::api::core::v1::ConfigMap;
use tauri::State;

/// List `ConfigMaps`
#[tauri::command]
pub async fn list_configmaps(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<ConfigMapInfo>> {
    list_resource_infos::<ConfigMap, ConfigMapInfo>(filters, state).await
}

/// Get a `ConfigMap` by name
#[tauri::command]
pub async fn get_configmap(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ConfigMapInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    get_resource_info::<ConfigMap, ConfigMapInfo>(name, namespace, state).await
}

/// Get `ConfigMap` data.
///
/// Through the same door as a Secret's values. A `ConfigMap` is not a Secret,
/// but nothing stops someone pasting a private key into one — it happens —
/// and this path used to hand back `data` verbatim while the Secret path and
/// every YAML tab redacted the same bytes. A `ConfigMap` carries no `type`, so
/// the PEM-label and key-name nets are the ones that catch it.
///
/// `binaryData` is read too. It was dropped entirely before, which made a
/// `ConfigMap` holding only binary keys look empty.
#[tauri::command]
pub async fn get_configmap_data(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ConfigData> {
    crate::validation::validate_dns_subdomain(&name)?;
    let configmap: ConfigMap =
        crate::commands::helpers::get_resource(name, namespace, state).await?;

    let mut out = ConfigData::default();
    for (key, value) in configmap.data.unwrap_or_default() {
        out.take("", key, value.as_bytes());
    }
    for (key, value) in configmap.binary_data.unwrap_or_default() {
        out.take("", key, &value.0);
    }
    Ok(out)
}

/// Write one key of a `ConfigMap`, leaving the rest alone.
///
/// A merge patch on that one field rather than a replace of the object.
/// Editing the whole `ConfigMap` as YAML is already possible and is what a
/// reader asked to stop doing (#107): a value that is itself JSON turns into
/// an indentation puzzle, and one mis-typed space rewrites a key nobody
/// touched. Patching the field they edited cannot do that, and it will not
/// clobber a change somebody else made to a different key in the meantime.
///
/// `binaryData` is deliberately out of scope. A key held there is bytes, and
/// a text box is not the way to edit bytes — the YAML editor still is.
#[tauri::command]
pub async fn set_configmap_key(
    name: String,
    key: String,
    value: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    use kube::api::{Patch, PatchParams};

    crate::validation::validate_dns_subdomain(&name)?;
    crate::validation::validate_config_key(&key)?;

    let ctx = crate::commands::helpers::ResourceContext::for_command(&state, namespace)?;
    let api: kube::Api<ConfigMap> = ctx.namespaced_api();

    // Named apart from the key so a reader of the patch can see which half is
    // ours and which is theirs.
    let patch = serde_json::json!({ "data": { key: value } });
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// Delete `ConfigMap`
#[tauri::command]
pub async fn delete_configmap(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    crate::commands::helpers::delete_resource::<ConfigMap>(name, namespace, state, None).await
}
