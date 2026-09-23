//! Tauri commands operating on instances (custom resources) of a CRD.
//!
//! Each command needs the same dynamic Api — the kind at the version the
//! cluster serves — and `on_served` is the one place it is built and asked.

use std::future::Future;

use kube::api::{Api, DeleteParams, DynamicObject, ListParams, Patch, PatchParams};
use tauri::State;

use crate::commands::helpers::{across, build_list_params, ResourceContext, Scoped};
use crate::error::{Error, Result};
use crate::state::AppState;

use super::convert::{dynamic_object_to_custom_resource_info, dynamic_object_to_detail_info};
use super::types::{CustomResourceDetailInfo, CustomResourceInfo};

/// One request on a CRD's kind, at the version the cluster serves it — its
/// name is `<plural>.<group>`, and discovery says the rest. Every instance
/// command asks through here, and a 404 is taken as the CRD having moved on:
/// the next call looks again rather than trusting a version the cluster may
/// have stopped serving. Only a list's 404 used to, so a detail page said
/// "not found" about an object that was there.
///
/// `listing` is the difference between the two kinds of caller: a list
/// with no namespace means every namespace, while a get or a delete with
/// none means the default one. Collapsing both onto `for_command` narrowed
/// every unscoped list to `default`, and the answer that came back — none
/// of them, on a cluster full of them — looked exactly like a true one.
async fn on_served<T, Fut>(
    state: &AppState,
    crd_name: &str,
    namespace: Option<String>,
    listing: bool,
    request: impl FnOnce(Api<DynamicObject>) -> Fut,
) -> Result<T>
where
    Fut: Future<Output = kube::Result<T>>,
{
    let not_served = || Error::NotFound {
        kind: "CustomResourceDefinition".to_string(),
        name: crd_name.to_string(),
        namespace: String::new(),
    };
    let (plural, group) = crd_name.split_once('.').ok_or_else(not_served)?;
    let served = state.served(group, plural).await?.ok_or_else(not_served)?;

    let ctx = if !served.namespaced {
        ResourceContext::for_list(state, None)?
    } else if listing {
        ResourceContext::for_list(state, namespace)?
    } else {
        ResourceContext::for_command(state, namespace)?
    };

    let answer = request(ctx.dynamic_api_for_resource(&served.resource, !served.namespaced)).await;
    if matches!(&answer, Err(kube::Error::Api(status)) if status.code == 404) {
        state.forget_served(group);
    }
    answer.map_err(Error::from)
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
    let params = build_list_params(label_selector.as_deref(), None, limit);
    instances_in(&crd_name, namespace, &params, &state).await
}

/// The instances page's read: one LIST per namespace of the scope. A
/// cluster-scoped kind has no namespaces to read across and is read once.
#[tauri::command]
pub async fn list_custom_resources_in(
    crd_name: String,
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Scoped<CustomResourceInfo>> {
    crate::validation::validate_dns_subdomain(&crd_name)?;
    let (plural, group) = crd_name.split_once('.').unwrap_or_default();
    let namespaced = state
        .served(group, plural)
        .await?
        .is_none_or(|served| served.namespaced);
    let scope = if namespaced { scope } else { None };
    let params = build_list_params(None, None, None);
    across(scope, |reach| {
        instances_in(&crd_name, reach, &params, &state)
    })
    .await
}

async fn instances_in(
    crd_name: &str,
    namespace: Option<String>,
    params: &ListParams,
    state: &AppState,
) -> Result<Vec<CustomResourceInfo>> {
    Ok(
        on_served(state, crd_name, namespace, true, |api| async move {
            api.list(params).await
        })
        .await?
        .items
        .iter()
        .map(dynamic_object_to_custom_resource_info)
        .collect(),
    )
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

    let obj = on_served(&state, &crd_name, namespace, false, |api| async move {
        api.get(&name).await
    })
    .await?;

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

    let obj = on_served(&state, &crd_name, namespace, false, |api| async move {
        api.get(&name).await
    })
    .await?;

    let yaml = serde_yaml::to_string(&obj).map_err(|e| Error::Serialization(e.to_string()))?;
    crate::commands::helpers::clean_yaml_for_editor(&yaml)
}

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
    on_served(&state, &crd_name, namespace, false, |api| async move {
        api.patch(&name, &PatchParams::default(), &Patch::Merge(patch))
            .await
    })
    .await?;
    Ok(())
}

/// A JSON Patch (RFC 6902) on one custom resource: the only kind of patch
/// that can change one element of a list.
///
/// A JSON *merge* patch replaces a list wholesale, so editing one rack of a
/// `ScyllaCluster` by re-sending the list rebuilt from what the page happened
/// to model deleted every field the model does not carry — storage,
/// resources, placement — from **every** rack. Reproduced against a real
/// apiserver: scaling one rack from 3 to 5 left `[{name, members}]` and
/// nothing else.
///
/// The operations pass through as the caller wrote them, so a `test` op can
/// guard the index about to be written: if the list moved since the page
/// read it, the apiserver rejects the whole patch rather than writing to the
/// wrong element.
#[tauri::command]
pub async fn patch_custom_resource_json(
    crd_name: String,
    name: String,
    namespace: Option<String>,
    operations: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&crd_name)?;
    crate::validation::validate_dns_subdomain(&name)?;
    if let Some(ns) = namespace.as_deref() {
        crate::validation::validate_namespace(ns)?;
    }
    let patch: json_patch::Patch = serde_json::from_value(operations)
        .map_err(|e| crate::error::Error::InvalidInput(format!("not a JSON Patch: {e}")))?;
    if patch.0.is_empty() {
        return Err(crate::error::Error::InvalidInput(
            "a JSON Patch with no operations changes nothing".to_string(),
        ));
    }
    on_served(&state, &crd_name, namespace, false, |api| async move {
        api.patch(&name, &PatchParams::default(), &Patch::Json::<()>(patch))
            .await
    })
    .await?;
    Ok(())
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
    if let Some(ns) = namespace.as_deref() {
        crate::validation::validate_namespace(ns)?;
    }

    on_served(&state, &crd_name, namespace, false, |api| async move {
        api.delete(&name, &DeleteParams::default()).await
    })
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    /// Every command in this file that writes. A new one is a new place a
    /// name from the frontend reaches a request path.
    const WRITES: [&str; 3] = [
        "pub async fn patch_custom_resource(",
        "pub async fn patch_custom_resource_json(",
        "pub async fn delete_custom_resource(",
    ];

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

        // The guard is in the source of every writing command. The test
        // module names them too, so only the code above it is scanned.
        let source = include_str!("instance.rs");
        let code = source.split("#[cfg(test)]").next().expect("has code");
        let writes: Vec<&str> = code
            .split("#[tauri::command]")
            .filter(|f| WRITES.iter().any(|w| f.contains(w)))
            .collect();
        assert_eq!(
            writes.len(),
            WRITES.len(),
            "a writing command was added or renamed; add it to WRITES"
        );
        for f in writes {
            assert!(
                f.contains("validate_namespace(ns)"),
                "a writing command took an unchecked namespace"
            );
        }
    }

    /// What every command here does with a kind: a get, for one of them.
    async fn get(
        state: &crate::state::AppState,
        name: &str,
    ) -> crate::error::Result<kube::api::DynamicObject> {
        super::on_served(
            state,
            "httproutes.gateway.networking.k8s.io",
            Some("default".to_string()),
            false,
            |api| async move { api.get(name).await },
        )
        .await
    }

    /// A version the cluster stopped serving 404s on a get as much as on a
    /// list. Only a list's 404 used to send discovery back to the cluster, so
    /// a detail page said "not found" about an object that is there — and a
    /// get that skipped the rule stayed green, because the test called the
    /// rule and not the path the commands take.
    #[tokio::test]
    async fn a_404_from_a_discovered_kind_has_discovery_read_again() {
        use crate::client::served::test_server::{connected, failure, groups, resources};
        use crate::client::served::ServedIndex;
        use std::time::Duration;
        let served = ServedIndex::aged(
            Duration::from_mins(1),
            Duration::from_mins(2),
            Duration::from_millis(100),
        );
        let (state, hits) = connected(served, |path, _| match path {
            "/apis" => (200, groups("v1", &["v1"])),
            "/apis/gateway.networking.k8s.io/v1" => {
                (200, resources("v1", &[("httproutes", "HTTPRoute", true)]))
            }
            p if p.ends_with("/refused") => failure(403, "Forbidden"),
            _ => failure(404, "NotFound"),
        })
        .await;
        let asked = || hits.lock().unwrap().get("/apis").copied();

        assert!(get(&state, "refused").await.is_err());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(get(&state, "refused").await.is_err());
        assert!(get(&state, "refused").await.is_err());
        assert_eq!(
            asked(),
            Some(1),
            "a refusal says nothing about where it is served"
        );

        assert!(get(&state, "gone").await.is_err());
        assert_eq!(asked(), Some(1));
        assert!(get(&state, "gone").await.is_err());
        assert_eq!(asked(), Some(2), "the 404 sent discovery back");
    }
}
