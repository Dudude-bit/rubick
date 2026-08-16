//! Tauri commands operating on CRDs themselves (the CustomResourceDefinition
//! kind), not the instances of those CRDs.

use std::collections::BTreeMap;

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::Api;
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::state::AppState;

use super::types::{CrdDetailInfo, CrdGroup, CrdInfo};

/// List all CRDs, optionally grouped by API group
#[tauri::command]
pub async fn list_crds(grouped: Option<bool>, state: State<'_, AppState>) -> Result<Vec<CrdGroup>> {
    let list = crate::commands::helpers::list_cluster_resources::<CustomResourceDefinition>(
        state, None, None, None,
    )
    .await?;

    let crds: Vec<CrdInfo> = list.items.iter().map(CrdInfo::from).collect();

    if grouped.unwrap_or(true) {
        // Group by API group
        let mut groups: BTreeMap<String, Vec<CrdInfo>> = BTreeMap::new();
        for crd in crds {
            groups.entry(crd.group.clone()).or_default().push(crd);
        }

        // Sort CRDs within each group by name
        Ok(groups
            .into_iter()
            .map(|(group, mut crds)| {
                crds.sort_by(|a, b| a.name.cmp(&b.name));
                CrdGroup { group, crds }
            })
            .collect())
    } else {
        // Return as single "ungrouped" group
        Ok(vec![CrdGroup {
            group: String::new(),
            crds,
        }])
    }
}

/// Get CRD details by name
#[tauri::command]
pub async fn get_crd(name: String, state: State<'_, AppState>) -> Result<CrdDetailInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    let crd: CustomResourceDefinition =
        crate::commands::helpers::get_cluster_resource(name, state).await?;
    Ok(CrdDetailInfo::from(&crd))
}

/// Get CRD YAML
#[tauri::command]
pub async fn get_crd_yaml(name: String, state: State<'_, AppState>) -> Result<String> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_list(&state, None)?;
    let api: Api<CustomResourceDefinition> = ctx.cluster_api();
    let crd = api.get(&name).await?;

    let yaml = serde_yaml::to_string(&crd).map_err(|e| Error::Serialization(e.to_string()))?;
    crate::commands::helpers::clean_yaml_for_editor(&yaml)
}

/// Delete a CRD
#[tauri::command]
pub async fn delete_crd(name: String, state: State<'_, AppState>) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    crate::commands::helpers::delete_cluster_resource::<CustomResourceDefinition>(name, state, None)
        .await
}
