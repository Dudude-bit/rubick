//! Any kind the cluster serves, read without knowing it: the catalogue of
//! what is served, a list as the API server prints it, and one object.
//!
//! Every other command names its kind. These take a group and a plural, which
//! is what an address under `/c/<cluster>/<plural>[.<group>]` carries.

mod table;

use std::collections::HashMap;

use futures::future::join_all;
use kube::api::{Api, DynamicObject};
use kube::core::params::ListParams;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::client::served::Served;
use crate::commands::helpers::{clean_yaml_for_editor, scope_of, ResourceContext};
use crate::error::{Error, Result};
use crate::state::AppState;

pub use table::{ResourceTable, TableColumn, TableRow};

/// One kind the cluster serves, at the version kubectl would use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
    /// kubectl's short names for it, where aggregated discovery says them.
    pub short_names: Vec<String>,
    /// Whether it serves a `status` subresource: a `Lease` or a `ServiceAccount`
    /// has none, so a missing status is not one still to be written.
    #[serde(default)]
    pub has_status: Option<bool>,
}

/// An API group whose discovery did not answer. Its kinds are absent from
/// the catalogue because nobody could look, not because there are none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadGroup {
    pub group: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCatalog {
    pub entries: Vec<CatalogEntry>,
    pub unread: Vec<UnreadGroup>,
}

/// Every kind the current cluster serves, group by group. A group that
/// fails is named in `unread`; the list of groups failing fails the whole.
#[tauri::command]
pub async fn list_api_catalog(state: State<'_, AppState>) -> Result<ApiCatalog> {
    catalog(&state).await
}

pub(crate) async fn catalog(state: &AppState) -> Result<ApiCatalog> {
    let client = ResourceContext::for_list(state, None)?.client;
    let (groups, short) = futures::join!(client.list_api_groups(), short_names(&client));
    let groups = groups?;
    let names: Vec<String> = std::iter::once(String::new())
        .chain(groups.groups.into_iter().map(|group| group.name))
        .collect();
    let answers = join_all(names.iter().map(|group| state.served_recommended(group))).await;

    let mut catalog = ApiCatalog {
        entries: Vec::new(),
        unread: Vec::new(),
    };
    for (group, answer) in names.into_iter().zip(answers) {
        match answer {
            Ok(found) => catalog
                .entries
                .extend(
                    found
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(resource, caps)| CatalogEntry {
                            short_names: short
                                .get(&(resource.group.clone(), resource.plural.clone()))
                                .cloned()
                                .unwrap_or_default(),
                            group: resource.group,
                            version: resource.version,
                            kind: resource.kind,
                            plural: resource.plural,
                            namespaced: caps.scope == kube::discovery::Scope::Namespaced,
                            has_status: Some(
                                caps.subresources
                                    .iter()
                                    .any(|(sub, _)| sub.plural == "status"),
                            ),
                            verbs: caps.operations,
                        }),
                ),
            Err(failed) => catalog.unread.push(UnreadGroup {
                group,
                code: failed.code().to_string(),
                message: failed.to_string(),
            }),
        }
    }
    Ok(catalog)
}

/// kubectl's short names by group and plural. Only aggregated discovery says
/// them in a form kube keeps; a cluster that does not serve it, or refuses
/// it, leaves every kind without, and the frontend's table stands in.
async fn short_names(client: &kube::Client) -> HashMap<(String, String), Vec<String>> {
    let (core, groups) = futures::join!(
        client.list_core_api_versions_aggregated(),
        client.list_api_groups_aggregated()
    );
    let mut names = HashMap::new();
    for list in [core, groups].into_iter().flatten() {
        for group in list.items {
            let group_name = group
                .metadata
                .and_then(|meta| meta.name)
                .unwrap_or_default();
            for version in group.versions {
                for resource in version.resources {
                    let Some(plural) = resource.resource else {
                        continue;
                    };
                    if !resource.short_names.is_empty() {
                        names
                            .entry((group_name.clone(), plural))
                            .or_insert(resource.short_names);
                    }
                }
            }
        }
    }
    names
}

/// One page of a kind's list, as the API server prints it for kubectl.
/// `cursor` is the previous page's, opaque; none starts at the top.
#[tauri::command]
pub async fn list_resource_table(
    group: String,
    plural: String,
    scope: Option<Vec<String>>,
    cursor: Option<String>,
    state: State<'_, AppState>,
) -> Result<ResourceTable> {
    let served = served(&state, &group, &plural).await?;
    let scope = if served.namespaced {
        scope_of(scope)?
    } else {
        None
    };
    let client = ResourceContext::for_list(&state, None)?.client;
    table::page(&client, &served, scope, cursor.as_deref()).await
}

/// One object of any served kind, whole, as the API server returned it.
#[tauri::command]
pub async fn get_served_object(
    group: String,
    plural: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let object = object(&state, &group, &plural, &name, namespace).await?;
    serde_json::to_value(object).map_err(|e| Error::Serialization(e.to_string()))
}

/// The same object as the YAML editor shows every kind.
#[tauri::command]
pub async fn get_served_object_yaml(
    group: String,
    plural: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    let object = object(&state, &group, &plural, &name, namespace).await?;
    let yaml = serde_yaml::to_string(&object).map_err(|e| Error::Serialization(e.to_string()))?;
    clean_yaml_for_editor(&yaml)
}

/// How many siblings a page compares one object against. Enough for the
/// autoscalers of one namespace; past it, the answer says it was cut.
const SIBLINGS: u32 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServedObjects {
    pub items: Vec<serde_json::Value>,
    /// The kind has more objects here than were read.
    pub truncated: bool,
}

/// The objects of a small kind in one namespace, whole but for their
/// managed fields: what a page needs to compare one object with its
/// siblings, such as two autoscalers aimed at one workload.
#[tauri::command]
pub async fn list_served_objects(
    group: String,
    plural: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ServedObjects> {
    let served = served(&state, &group, &plural).await?;
    let api = if served.namespaced {
        ResourceContext::for_command(&state, namespace)?
            .dynamic_api_for_resource(&served.resource, false)
    } else {
        ResourceContext::for_list(&state, None)?.dynamic_api_for_resource(&served.resource, true)
    };
    let answer = api.list(&page_params(SIBLINGS, None)).await;
    let list = state.served_answer(&group, answer)?;
    let truncated = list
        .metadata
        .continue_
        .as_deref()
        .is_some_and(|token| !token.is_empty());
    let items = list
        .items
        .into_iter()
        .map(|mut object| {
            object.metadata.managed_fields = None;
            serde_json::to_value(object)
        })
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| Error::Serialization(e.to_string()))?;
    Ok(ServedObjects { items, truncated })
}

async fn served(state: &AppState, group: &str, plural: &str) -> Result<Served> {
    if !group.is_empty() {
        crate::validation::validate_dns_subdomain(group)?;
    }
    crate::validation::validate_dns_label(plural)?;
    state
        .served(group, plural)
        .await?
        .ok_or_else(|| Error::not_found("APIResource", served_name(group, plural), ""))
}

fn served_name(group: &str, plural: &str) -> String {
    if group.is_empty() {
        plural.to_string()
    } else {
        format!("{plural}.{group}")
    }
}

async fn object(
    state: &AppState,
    group: &str,
    plural: &str,
    name: &str,
    namespace: Option<String>,
) -> Result<DynamicObject> {
    crate::validation::validate_path_segment(name)?;
    let served = served(state, group, plural).await?;
    let api: Api<DynamicObject> = if served.namespaced {
        ResourceContext::for_command(state, namespace)?
            .dynamic_api_for_resource(&served.resource, false)
    } else {
        ResourceContext::for_list(state, None)?.dynamic_api_for_resource(&served.resource, true)
    };
    let answer = api.get(name).await;
    Ok(state.served_answer(group, answer)?)
}

/// The list parameters for one page, `limit` rows from `token`.
fn page_params(limit: u32, token: Option<String>) -> ListParams {
    ListParams {
        limit: Some(limit),
        continue_token: token,
        ..ListParams::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::{connected, failure};
    use crate::client::served::ServedIndex;
    use serde_json::json;

    fn resources(group_version: &str, kinds: &[(&str, &str)]) -> String {
        json!({
            "kind": "APIResourceList",
            "groupVersion": group_version,
            "resources": kinds.iter().map(|(plural, kind)| json!({
                "name": plural, "singularName": "", "namespaced": true,
                "kind": kind, "verbs": ["get", "list"],
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    fn group(name: &str) -> serde_json::Value {
        let version = json!({ "groupVersion": format!("{name}/v1"), "version": "v1" });
        json!({ "name": name, "versions": [version], "preferredVersion": version })
    }

    /// A group whose discovery fails is named rather than dropped: its kinds
    /// missing from the list would otherwise read as not installed.
    #[tokio::test]
    async fn a_group_that_does_not_answer_is_named_beside_the_ones_that_did() {
        let (state, _) = connected(ServedIndex::default(), |path, _| match path {
            "/api" => (200, json!({ "kind": "APIVersions", "versions": ["v1"], "serverAddressByClientCIDRs": [] }).to_string()),
            "/api/v1" => (200, resources("v1", &[("configmaps", "ConfigMap")])),
            "/apis" => (200, json!({ "kind": "APIGroupList", "groups": [group("ok.example.com"), group("broken.example.com")] }).to_string()),
            "/apis/ok.example.com/v1" => (200, resources("ok.example.com/v1", &[("widgets", "Widget")])),
            "/apis/broken.example.com/v1" => failure(503, "ServiceUnavailable"),
            _ => (404, "{}".to_string()),
        })
        .await;
        let found = catalog(&state).await.expect("catalog");
        let plurals: Vec<_> = found
            .entries
            .iter()
            .map(|e| (e.group.as_str(), e.plural.as_str()))
            .collect();
        assert!(plurals.contains(&("", "configmaps")));
        assert!(plurals.contains(&("ok.example.com", "widgets")));
        assert_eq!(found.unread.len(), 1);
        assert_eq!(found.unread[0].group, "broken.example.com");
        assert!(
            found.entries.iter().all(|e| e.short_names.is_empty()),
            "no aggregated discovery, no short names: the frontend's table stands in"
        );
    }

    /// `po`, `deploy` and `sts` found nothing in the palette: kube's discovery
    /// drops the short names the API server lists. Aggregated discovery keeps
    /// them, so the catalogue carries each kind's own, a custom one's too.
    #[tokio::test]
    async fn the_catalogue_carries_the_short_names_aggregated_discovery_lists() {
        let short = |plural: &str, short: &[&str]| json!({ "resource": plural, "shortNames": short, "verbs": ["list"] });
        let aggregated = |name: &str, resources: Vec<serde_json::Value>| json!({ "metadata": { "name": name }, "versions": [{ "version": "v1", "resources": resources }] });
        let (state, _) = connected(ServedIndex::default(), move |path, _| match path {
            "/api" => (
                200,
                json!({
                    "kind": "APIVersions", "versions": ["v1"], "serverAddressByClientCIDRs": [],
                    "items": [aggregated("", vec![short("configmaps", &["cm"])])],
                })
                .to_string(),
            ),
            "/api/v1" => (200, resources("v1", &[("configmaps", "ConfigMap")])),
            "/apis" => (
                200,
                json!({
                    "kind": "APIGroupList", "groups": [group("ok.example.com")],
                    "items": [aggregated("ok.example.com", vec![short("widgets", &["wd", "wds"])])],
                })
                .to_string(),
            ),
            "/apis/ok.example.com/v1" => (
                200,
                resources("ok.example.com/v1", &[("widgets", "Widget")]),
            ),
            _ => (404, "{}".to_string()),
        })
        .await;
        let found = catalog(&state).await.expect("catalog");
        let short_of = |plural: &str| {
            found
                .entries
                .iter()
                .find(|e| e.plural == plural)
                .map(|e| e.short_names.clone())
        };
        assert_eq!(short_of("configmaps"), Some(vec!["cm".to_string()]));
        assert_eq!(
            short_of("widgets"),
            Some(vec!["wd".to_string(), "wds".to_string()])
        );
    }

    /// A Lease page said "Status: Nothing reported yet", which reads as
    /// pending, for a kind that has no status at all. Discovery says which
    /// kinds serve one.
    #[tokio::test]
    async fn the_catalogue_says_which_kinds_serve_a_status() {
        let listed = |name: &str, kind: &str| json!({ "name": name, "singularName": "", "namespaced": true, "kind": kind, "verbs": ["get"] });
        let (state, _) = connected(ServedIndex::default(), move |path, _| match path {
            "/api" => (200, json!({ "kind": "APIVersions", "versions": ["v1"], "serverAddressByClientCIDRs": [] }).to_string()),
            "/api/v1" => (
                200,
                json!({
                    "kind": "APIResourceList", "groupVersion": "v1",
                    "resources": [
                        listed("pods", "Pod"),
                        listed("pods/status", "Pod"),
                        listed("serviceaccounts", "ServiceAccount"),
                    ],
                })
                .to_string(),
            ),
            "/apis" => (200, json!({ "kind": "APIGroupList", "groups": [] }).to_string()),
            _ => (404, "{}".to_string()),
        })
        .await;
        let found = catalog(&state).await.expect("catalog");
        let has = |plural: &str| {
            found
                .entries
                .iter()
                .find(|e| e.plural == plural)
                .and_then(|e| e.has_status)
        };
        assert_eq!(has("pods"), Some(true));
        assert_eq!(has("serviceaccounts"), Some(false));
    }
}
