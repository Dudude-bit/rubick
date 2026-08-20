//! Conversions from kube types to the frontend-facing structs.

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::DynamicObject;
use kube::ResourceExt;

use super::types::{
    CrdAcceptedNames, CrdCondition, CrdDetailInfo, CrdInfo, CrdVersionInfo,
    CustomResourceDetailInfo, CustomResourceInfo, OwnerReferenceInfo, PrinterColumn,
};

impl From<&CustomResourceDefinition> for CrdInfo {
    fn from(crd: &CustomResourceDefinition) -> Self {
        let spec = &crd.spec;
        let names = &spec.names;

        // Find storage version
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
            created_at: crd.creation_timestamp().map(|t| t.0),
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
                        last_transition_time: c.last_transition_time.as_ref().map(|t| t.0),
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
            group: spec.group.clone(),
            kind: names.kind.clone(),
            plural: names.plural.clone(),
            singular: names.singular.clone().unwrap_or_default(),
            scope: spec.scope.clone(),
            versions,
            short_names: names.short_names.clone().unwrap_or_default(),
            categories: names.categories.clone().unwrap_or_default(),
            labels: crd.labels().clone(),
            annotations: crd
                .annotations()
                .iter()
                .filter(|(k, _)| !k.starts_with("kubectl.kubernetes.io"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            conditions,
            created_at: crd.creation_timestamp().map(|t| t.0),
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
    labels: std::collections::BTreeMap<String, String>,
    annotations: std::collections::BTreeMap<String, String>,
    created_at: Option<chrono::DateTime<chrono::Utc>>,
    owner_references: Vec<OwnerReferenceInfo>,
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
        spec: obj
            .data
            .get("spec")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        status: obj.data.get("status").cloned(),
        labels: obj.labels().clone(),
        annotations: obj
            .annotations()
            .iter()
            .filter(|(k, _)| !k.starts_with("kubectl.kubernetes.io"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        created_at: obj.creation_timestamp().map(|t| t.0),
        owner_references,
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
        owner_references: f.owner_references,
        finalizers: obj.metadata.finalizers.clone().unwrap_or_default(),
        resource_version: obj.metadata.resource_version.clone(),
    }
}
