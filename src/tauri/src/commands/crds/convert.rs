//! Conversions from kube types to the frontend-facing structs.

use std::collections::BTreeMap;

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::DynamicObject;
use kube::ResourceExt;

use crate::utils::Moment;

use super::types::{
    CrdAcceptedNames, CrdCondition, CrdDetailInfo, CrdInfo, CrdVersionInfo,
    CustomResourceDetailInfo, CustomResourceInfo, OwnerReferenceInfo, PrinterColumn,
};

impl From<&CustomResourceDefinition> for CrdInfo {
    fn from(crd: &CustomResourceDefinition) -> Self {
        let spec = &crd.spec;
        let names = &spec.names;

        let storage_version = spec.versions.iter().find(|v| v.storage).map_or_else(
            || {
                spec.versions
                    .first()
                    .map(|v| v.name.clone())
                    .unwrap_or_default()
            },
            |v| v.name.clone(),
        );

        CrdInfo {
            name: crd.name_any(),
            group: spec.group.clone(),
            kind: names.kind.clone(),
            plural: names.plural.clone(),
            scope: spec.scope.clone(),
            version: storage_version,
            short_names: names.short_names.clone().unwrap_or_default(),
            categories: names.categories.clone().unwrap_or_default(),
            created_at: crd.creation_timestamp().map(|t| t.moment()),
        }
    }
}

impl From<&CustomResourceDefinition> for CrdDetailInfo {
    fn from(crd: &CustomResourceDefinition) -> Self {
        let spec = &crd.spec;
        let names = &spec.names;
        let status = crd.status.as_ref();

        let versions: Vec<CrdVersionInfo> = spec
            .versions
            .iter()
            .map(|v| {
                let schema = v
                    .schema
                    .as_ref()
                    .and_then(|s| s.open_api_v3_schema.as_ref())
                    .and_then(|s| serde_json::to_value(s).ok());

                let columns: Vec<PrinterColumn> = v
                    .additional_printer_columns
                    .as_ref()
                    .map(|cols| {
                        cols.iter()
                            .map(|c| PrinterColumn {
                                name: c.name.clone(),
                                column_type: c.type_.clone(),
                                json_path: c.json_path.clone(),
                                description: c.description.clone(),
                                priority: c.priority,
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                CrdVersionInfo {
                    name: v.name.clone(),
                    served: v.served,
                    storage: v.storage,
                    deprecated: v.deprecated.unwrap_or(false),
                    deprecation_warning: v.deprecation_warning.clone(),
                    schema,
                    additional_printer_columns: columns,
                }
            })
            .collect();

        let conditions: Vec<CrdCondition> = status
            .and_then(|s| s.conditions.as_ref())
            .map(|conds| {
                conds
                    .iter()
                    .map(|c| CrdCondition {
                        condition_type: c.type_.clone(),
                        status: c.status.clone(),
                        reason: c.reason.clone(),
                        message: c.message.clone(),
                        last_transition_time: c.last_transition_time.as_ref().map(Moment::moment),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let accepted = status.and_then(|s| s.accepted_names.as_ref()).map_or_else(
            || CrdAcceptedNames {
                kind: names.kind.clone(),
                plural: names.plural.clone(),
                singular: names.singular.clone(),
                short_names: names.short_names.clone().unwrap_or_default(),
                categories: names.categories.clone().unwrap_or_default(),
                list_kind: names.list_kind.clone(),
            },
            |a| CrdAcceptedNames {
                kind: a.kind.clone(),
                plural: a.plural.clone(),
                singular: a.singular.clone(),
                short_names: a.short_names.clone().unwrap_or_default(),
                categories: a.categories.clone().unwrap_or_default(),
                list_kind: a.list_kind.clone(),
            },
        );

        CrdDetailInfo {
            name: crd.name_any(),
            uid: crd.uid().unwrap_or_default(),
            group: spec.group.clone(),
            kind: names.kind.clone(),
            plural: names.plural.clone(),
            singular: names.singular.clone().unwrap_or_default(),
            scope: spec.scope.clone(),
            versions,
            short_names: names.short_names.clone().unwrap_or_default(),
            categories: names.categories.clone().unwrap_or_default(),
            labels: crd.labels().clone(),
            annotations: without_kubectl(crate::resources::annotations_of(&crd.metadata)),
            conditions,
            created_at: crd.creation_timestamp().map(|t| t.moment()),
            accepted_names: accepted,
        }
    }
}

/// Fields shared by `CustomResourceInfo` and `CustomResourceDetailInfo`.
/// Extracted into one struct so the two `dynamic_object_to_*` functions
/// don't duplicate the metadata-extraction logic.
struct CommonResourceFields {
    name: String,
    namespace: Option<String>,
    uid: String,
    api_version: String,
    kind: String,
    spec: serde_json::Value,
    status: Option<serde_json::Value>,
    labels: BTreeMap<String, String>,
    annotations: BTreeMap<String, String>,
    created_at: Option<chrono::DateTime<chrono::Utc>>,
    owner_references: Vec<OwnerReferenceInfo>,
    /// Every other top-level field, judged with the two above.
    rest: serde_json::Value,
}

/// Annotations without kubectl's own bookkeeping, which these pages leave out.
fn without_kubectl(mut annotations: BTreeMap<String, String>) -> BTreeMap<String, String> {
    annotations.retain(|key, _| !key.starts_with("kubectl.kubernetes.io"));
    annotations
}

fn extract_common_fields(obj: &DynamicObject) -> CommonResourceFields {
    let owner_references = obj
        .metadata
        .owner_references
        .as_ref()
        .map(|refs| {
            refs.iter()
                .map(|r| OwnerReferenceInfo {
                    api_version: r.api_version.clone(),
                    kind: r.kind.clone(),
                    name: r.name.clone(),
                    uid: r.uid.clone(),
                    controller: r.controller,
                })
                .collect()
        })
        .unwrap_or_default();

    // What the object says, judged once by the rule that withholds a private
    // key: a key map at the top level, and every string of `spec` and `status`.
    let mut rest = obj.data.clone();
    crate::resources::redact_private_keys(&mut rest);
    let mut take = |field: &str| rest.as_object_mut().and_then(|fields| fields.remove(field));
    let (spec, status) = (take("spec"), take("status"));

    CommonResourceFields {
        name: obj.name_any(),
        namespace: obj.namespace(),
        uid: obj.metadata.uid.clone().unwrap_or_default(),
        api_version: obj
            .types
            .as_ref()
            .map(|t| t.api_version.clone())
            .unwrap_or_default(),
        kind: obj
            .types
            .as_ref()
            .map(|t| t.kind.clone())
            .unwrap_or_default(),
        spec: spec.unwrap_or(serde_json::Value::Null),
        status,
        labels: obj.labels().clone(),
        annotations: without_kubectl(crate::resources::annotations_of(&obj.metadata)),
        created_at: obj.creation_timestamp().map(|t| t.moment()),
        owner_references,
        rest,
    }
}

#[must_use]
pub fn dynamic_object_to_custom_resource_info(obj: &DynamicObject) -> CustomResourceInfo {
    let f = extract_common_fields(obj);
    CustomResourceInfo {
        name: f.name,
        namespace: f.namespace,
        uid: f.uid,
        api_version: f.api_version,
        kind: f.kind,
        spec: f.spec,
        status: f.status,
        labels: f.labels,
        annotations: f.annotations,
        created_at: f.created_at,
        generation: obj.metadata.generation,
        owner_references: f.owner_references,
    }
}

pub(super) fn dynamic_object_to_detail_info(obj: &DynamicObject) -> CustomResourceDetailInfo {
    let f = extract_common_fields(obj);
    CustomResourceDetailInfo {
        name: f.name,
        namespace: f.namespace,
        uid: f.uid,
        api_version: f.api_version,
        kind: f.kind,
        spec: f.spec,
        status: f.status,
        labels: f.labels,
        annotations: f.annotations,
        created_at: f.created_at,
        generation: obj.metadata.generation,
        owner_references: f.owner_references,
        finalizers: obj.metadata.finalizers.clone().unwrap_or_default(),
        resource_version: obj.metadata.resource_version.clone(),
        fields: match f.rest {
            serde_json::Value::Object(fields) => fields.into_iter().collect(),
            _ => BTreeMap::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Its Events tab keeps an earlier definition's events off the one there
    /// now by its uid. Fails if the detail stops carrying it.
    #[test]
    fn a_definition_carries_its_uid() {
        let crd: CustomResourceDefinition = serde_json::from_value(json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": { "name": "widgets.demo.io", "uid": "4afe41e6" },
            "spec": {
                "group": "demo.io",
                "names": { "kind": "Widget", "plural": "widgets" },
                "scope": "Namespaced",
                "versions": [],
            },
        }))
        .expect("a definition this test wrote");
        assert_eq!(CrdDetailInfo::from(&crd).uid, "4afe41e6");
    }

    /// An `EndpointSlice` keeps its endpoints at the top level; without them
    /// its peek read "No spec" about an object full of addresses.
    #[test]
    fn a_payload_kept_at_the_top_level_is_carried_beside_spec_and_status() {
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "discovery.k8s.io/v1",
            "kind": "EndpointSlice",
            "metadata": { "name": "kube-dns-f2mvh", "namespace": "kube-system" },
            "addressType": "IPv4",
            "endpoints": [{ "addresses": ["10.0.0.5"] }],
        }))
        .expect("object");
        let detail = dynamic_object_to_detail_info(&obj);
        assert_eq!(
            detail.fields.keys().map(String::as_str).collect::<Vec<_>>(),
            ["addressType", "endpoints"]
        );
        assert_eq!(detail.fields["addressType"], json!("IPv4"));
        assert_eq!(detail.spec, serde_json::Value::Null);
    }

    /// A Flux `HelmRelease` keeps its chart's values in `spec`, and the list
    /// row, the watch, the page and the peek carried `spec` and `status` as
    /// read. Fails if a key in either leaves on the row or the detail, or if
    /// what stood beside it does not.
    #[test]
    fn a_custom_resources_spec_and_status_leave_without_a_private_key() {
        const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "helm.toolkit.fluxcd.io/v2",
            "kind": "HelmRelease",
            "metadata": { "name": "web", "namespace": "shop" },
            "spec": { "chart": "web", "values": { "tls": { "key": KEY } } },
            "status": { "lastAttemptedValues": KEY, "observedGeneration": 3 },
            "signing": [KEY],
        }))
        .expect("an object this test wrote");

        let row = dynamic_object_to_custom_resource_info(&obj);
        let detail = dynamic_object_to_detail_info(&obj);
        let marker = crate::resources::WITHHELD_MARKER;
        for (spec, status) in [(&row.spec, &row.status), (&detail.spec, &detail.status)] {
            assert_eq!(spec["values"]["tls"]["key"], marker);
            assert_eq!(spec["chart"], "web");
            let status = status.as_ref().expect("a status");
            assert_eq!(status["lastAttemptedValues"], marker);
            assert_eq!(status["observedGeneration"], 3);
        }
        assert_eq!(detail.fields["signing"], json!([marker]));
        assert_eq!(detail.fields.len(), 1, "spec and status are not repeated");
    }

    /// A custom resource's page and peek are built from this, beside the
    /// YAML tab that withholds the same key. Fails if the record a tool
    /// keeps in an annotation, or a key map at the top level, carries it.
    #[test]
    fn a_custom_resource_is_handed_over_without_a_private_key() {
        const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");
        let original = json!({ "kind": "Bundle", "data": { "client.key": KEY } });
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "demo.io/v1",
            "kind": "Bundle",
            "metadata": {
                "name": "edge",
                "annotations": { "kapp.k14s.io/original": original.to_string(), "team": "edge" },
            },
            "data": { "client.key": KEY, "ca.crt": "not a key" },
        }))
        .expect("an object this test wrote");

        let row = dynamic_object_to_custom_resource_info(&obj);
        let detail = dynamic_object_to_detail_info(&obj);
        for annotations in [&row.annotations, &detail.annotations] {
            assert_eq!(annotations["team"], "edge");
            assert!(annotations["kapp.k14s.io/original"].contains("\"client.key\":\"<withheld"));
            assert!(!annotations["kapp.k14s.io/original"].contains("PRIVATE KEY"));
        }
        assert_eq!(
            detail.fields["data"]["client.key"],
            crate::resources::WITHHELD_MARKER
        );
        assert_eq!(detail.fields["data"]["ca.crt"], "not a key");
    }
}
