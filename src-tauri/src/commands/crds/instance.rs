//! Tauri commands operating on instances (custom resources) of a CRD.
//!
//! Each command does the same dance — load the CRD, find storage
//! version, build a `kube::discovery::ApiResource`, then wrap a
//! dynamic Api around it. `crd_to_dynamic_api` collapses that into
//! a single helper.

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, DeleteParams, DynamicObject, Patch, PatchParams};
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
/// A merge patch on one custom resource: how an operator's knobs are turned
/// (an annotation, a spec field), never a whole-object replace.
#[tauri::command]
pub async fn patch_custom_resource(
    crd_name: String,
    name: String,
    namespace: Option<String>,
    patch: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&crd_name)?;
    crate::validation::validate_dns_subdomain(&name)?;
    // The namespace is a path segment too. `normalize_optional_namespace`
    // only trims it, so without this the one command in this file that
    // *writes* took an unchecked string straight into the request path.
    if let Some(ns) = namespace.as_deref() {
        crate::validation::validate_namespace(ns)?;
    }
    if !patch.is_object() {
        return Err(crate::error::Error::InvalidInput(
            "a patch is a JSON object".to_string(),
        ));
    }
    let api = crd_to_dynamic_api(&crd_name, namespace, false, &state).await?;
    api.patch(&name, &PatchParams::default(), &Patch::Merge(patch))
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_custom_resource(
    crd_name: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&crd_name)?;
    crate::validation::validate_dns_subdomain(&name)?;
    if let Some(ns) = namespace.as_deref() {
        crate::validation::validate_namespace(ns)?;
    }

    let api = crd_to_dynamic_api(&crd_name, namespace, false, &state).await?;
    api.delete(&name, &DeleteParams::default()).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    /// Every name that reaches a request path is checked. `crd_name` and
    /// `name` always were; `namespace` was not, and
    /// `normalize_optional_namespace` only trims — so the one command here
    /// that writes took an unchecked segment. The commands are `async` and
    /// need a cluster, so this pins the validators rather than the calls.
    #[test]
    fn a_namespace_from_the_frontend_is_checked_like_every_other_name() {
        use crate::validation::{validate_dns_subdomain, validate_namespace};
        assert!(validate_namespace("cnpg-system").is_ok());
        assert!(validate_namespace("../kube-system").is_err());
        assert!(validate_namespace("a/b").is_err());
        assert!(validate_namespace("").is_err());
        assert!(validate_dns_subdomain("clusters.postgresql.cnpg.io").is_ok());
        assert!(validate_dns_subdomain("../clusters").is_err());

        // The guard is in the source of both writing commands. The test
        // module names them too, so only the code above it is scanned.
        let source = include_str!("instance.rs");
        let code = source.split("#[cfg(test)]").next().expect("has code");
        let writes: Vec<&str> = code
            .split("#[tauri::command]")
            .filter(|f| {
                f.contains("pub async fn patch_custom_resource")
                    || f.contains("pub async fn delete_custom_resource")
            })
            .collect();
        assert_eq!(writes.len(), 2, "both writing commands must be found");
        for f in writes {
            assert!(
                f.contains("validate_namespace(ns)"),
                "a writing command took an unchecked namespace"
            );
        }
    }
}
