//! Tauri commands for manifest validate / apply / delete / get.

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::state::AppState;
use kube::api::{Patch, PatchParams};
use tauri::State;

use super::parse::{api_resource_for, is_cluster_scoped, parse_all_documents};
use super::ManifestResult;

/// Validate a Kubernetes manifest (parse and check structure).
///
/// This performs client-side validation of the manifest without applying it.
#[tauri::command]
pub async fn validate_manifest(
    manifest: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ManifestResult> {
    let parsed_docs = match parse_all_documents(&manifest) {
        Ok(docs) => docs,
        Err(e) => return Ok(ManifestResult::error(e.to_string())),
    };

    let results: Vec<String> = parsed_docs
        .iter()
        .map(|p| p.format_id(&p.effective_namespace(&namespace), "validated"))
        .collect();

    // Verify we have a connection for server-side validation
    if state.get_current_context().is_none() {
        return Ok(ManifestResult::error(
            "No cluster connected. Client-side validation passed, but server validation skipped."
                .to_string(),
        ));
    }

    Ok(ManifestResult::success(format!(
        "Validation passed:\n{}",
        results.join("\n")
    )))
}

/// Apply a Kubernetes manifest to the cluster using server-side apply
#[tauri::command]
pub async fn apply_manifest(
    manifest: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ManifestResult> {
    let parsed_docs = match parse_all_documents(&manifest) {
        Ok(docs) => docs,
        Err(e) => return Ok(ManifestResult::error(e.to_string())),
    };

    let mut results = Vec::new();
    let patch_params = PatchParams::apply("k8s-gui").force();

    for parsed in parsed_docs {
        let ns = parsed.effective_namespace(&namespace);
        let name = parsed.name();
        let ctx = ResourceContext::for_command(&state, Some(ns.clone()))?;
        let api = ctx.dynamic_api_for_resource(
            &parsed.api_resource,
            is_cluster_scoped(&parsed.api_resource.kind),
        );

        match api
            .patch(&name, &patch_params, &Patch::Apply(&parsed.object))
            .await
        {
            Ok(_) => results.push(parsed.format_id(&ns, "configured")),
            Err(e) => {
                return Ok(ManifestResult::error(format!(
                    "Failed to apply {}: {}",
                    parsed.format_id(&ns, ""),
                    e
                )));
            }
        }
    }

    Ok(ManifestResult::success(results.join("\n")))
}

/// Get a resource manifest as YAML
///
/// Fetches any Kubernetes resource by kind, apiVersion, name and namespace.
#[tauri::command]
pub async fn get_manifest(
    kind: String,
    api_version: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    let api_resource = api_resource_for(&kind, &api_version);

    let ns = namespace.unwrap_or_else(|| "default".to_string());
    let ctx = ResourceContext::for_command(&state, Some(ns.clone()))?;
    let api = ctx.dynamic_api_for_resource(&api_resource, is_cluster_scoped(&api_resource.kind));

    let resource = api.get(&name).await?;

    // Every detail page's YAML tab comes through here, Secrets included, and
    // base64 is not a control: `tls.key` in a manifest is one `base64 -d`
    // from being the key.
    let mut object =
        serde_json::to_value(&resource).map_err(|e| Error::Serialization(e.to_string()))?;
    crate::resources::redact_private_keys(&mut object);

    let yaml = serde_yaml::to_string(&object).map_err(|e| Error::Serialization(e.to_string()))?;

    crate::commands::helpers::clean_yaml_for_editor(&yaml)
}
