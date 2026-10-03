//! Type definitions for CRD and custom resource commands.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// CRD information for list view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdInfo {
    pub name: String,
    pub group: String,
    pub kind: String,
    pub plural: String,
    pub scope: String,
    pub version: String,
    pub short_names: Vec<String>,
    pub categories: Vec<String>,
    pub created_at: Option<DateTime<Utc>>,
}

/// CRD group for grouped list view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdGroup {
    pub group: String,
    pub crds: Vec<CrdInfo>,
}

/// CRD version information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdVersionInfo {
    pub name: String,
    pub served: bool,
    pub storage: bool,
    pub deprecated: bool,
    pub deprecation_warning: Option<String>,
    pub schema: Option<serde_json::Value>,
    pub additional_printer_columns: Vec<PrinterColumn>,
}

/// Printer column definition from CRD
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterColumn {
    pub name: String,
    pub column_type: String,
    pub json_path: String,
    pub description: Option<String>,
    pub priority: Option<i32>,
}

/// CRD condition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdCondition {
    pub condition_type: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_transition_time: Option<DateTime<Utc>>,
}

/// CRD detail information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdDetailInfo {
    pub name: String,
    pub group: String,
    pub kind: String,
    pub plural: String,
    pub singular: String,
    pub scope: String,
    pub versions: Vec<CrdVersionInfo>,
    pub short_names: Vec<String>,
    pub categories: Vec<String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub conditions: Vec<CrdCondition>,
    pub created_at: Option<DateTime<Utc>>,
    pub accepted_names: CrdAcceptedNames,
}

/// CRD accepted names
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdAcceptedNames {
    pub kind: String,
    pub plural: String,
    pub singular: Option<String>,
    pub short_names: Vec<String>,
    pub categories: Vec<String>,
    pub list_kind: Option<String>,
}

/// Custom resource instance information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomResourceInfo {
    pub name: String,
    pub namespace: Option<String>,
    pub uid: String,
    pub api_version: String,
    pub kind: String,
    pub spec: serde_json::Value,
    pub status: Option<serde_json::Value>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<DateTime<Utc>>,
    pub owner_references: Vec<OwnerReferenceInfo>,
    /// `metadata.generation`, so a page can compare it with what the
    /// operator says it has observed.
    pub generation: Option<i64>,
}

/// Owner reference information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerReferenceInfo {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub uid: String,
    pub controller: Option<bool>,
}

/// Custom resource detail with full data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomResourceDetailInfo {
    pub name: String,
    pub namespace: Option<String>,
    pub uid: String,
    pub api_version: String,
    pub kind: String,
    pub spec: serde_json::Value,
    pub status: Option<serde_json::Value>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<DateTime<Utc>>,
    pub owner_references: Vec<OwnerReferenceInfo>,
    pub finalizers: Vec<String>,
    pub resource_version: Option<String>,
    /// `metadata.generation`, as on the list shape.
    pub generation: Option<i64>,
}
