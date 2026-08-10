//! Lighter resource types — Namespace, ConfigMap, Secret, Event.
//! Grouped because each is a single struct with one `From` impl,
//! all driven by the same metadata-extraction pattern.

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::{ConfigMap, Event, Namespace, Secret};
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Namespace information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceInfo {
    pub name: String,
    pub uid: String,
    pub status: String,
    pub labels: BTreeMap<String, String>,
    pub created_at: Option<DateTime<Utc>>,
}

impl From<&Namespace> for NamespaceInfo {
    fn from(ns: &Namespace) -> Self {
        Self {
            name: ns.name_any(),
            uid: ns.uid().unwrap_or_default(),
            status: ns
                .status
                .as_ref()
                .and_then(|s| s.phase.clone())
                .unwrap_or_else(|| "Active".to_string()),
            labels: ns.labels().clone(),
            created_at: ns.creation_timestamp().map(|t| t.0),
        }
    }
}

/// `ConfigMap` information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMapInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub data_keys: Vec<String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<DateTime<Utc>>,
}

impl From<&ConfigMap> for ConfigMapInfo {
    fn from(cm: &ConfigMap) -> Self {
        Self {
            name: cm.name_any(),
            namespace: cm.namespace().unwrap_or_default(),
            uid: cm.uid().unwrap_or_default(),
            // Both maps: a ConfigMap holding only `binaryData` is not an
            // empty ConfigMap, and the key count on the page comes from here.
            data_keys: cm
                .data
                .iter()
                .flatten()
                .map(|(key, _)| key.clone())
                .chain(cm.binary_data.iter().flatten().map(|(key, _)| key.clone()))
                .collect(),
            labels: cm.labels().clone(),
            annotations: cm.annotations().clone(),
            created_at: cm.creation_timestamp().map(|t| t.0),
        }
    }
}

/// Secret information (without sensitive data)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub type_: String,
    pub data_keys: Vec<String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<DateTime<Utc>>,
}

impl From<&Secret> for SecretInfo {
    fn from(secret: &Secret) -> Self {
        Self {
            name: secret.name_any(),
            namespace: secret.namespace().unwrap_or_default(),
            uid: secret.uid().unwrap_or_default(),
            type_: secret.type_.clone().unwrap_or_else(|| "Opaque".to_string()),
            data_keys: secret
                .data
                .as_ref()
                .map(|d| d.keys().cloned().collect())
                .unwrap_or_default(),
            labels: secret.labels().clone(),
            annotations: secret.annotations().clone(),
            created_at: secret.creation_timestamp().map(|t| t.0),
        }
    }
}

/// Event information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub type_: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub source: Option<String>,
    pub involved_object: InvolvedObjectInfo,
    pub count: Option<i32>,
    pub first_timestamp: Option<DateTime<Utc>>,
    pub last_timestamp: Option<DateTime<Utc>>,
}

/// Involved object information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvolvedObjectInfo {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub uid: Option<String>,
}

impl From<&Event> for EventInfo {
    fn from(event: &Event) -> Self {
        Self {
            name: event.name_any(),
            namespace: event.namespace().unwrap_or_default(),
            uid: event.uid().unwrap_or_default(),
            type_: event.type_.clone().unwrap_or_default(),
            reason: event.reason.clone(),
            message: event.message.clone(),
            source: event.source.as_ref().and_then(|s| s.component.clone()),
            involved_object: InvolvedObjectInfo {
                kind: event.involved_object.kind.clone().unwrap_or_default(),
                name: event.involved_object.name.clone().unwrap_or_default(),
                namespace: event.involved_object.namespace.clone(),
                uid: event.involved_object.uid.clone(),
            },
            count: event.count,
            first_timestamp: event.first_timestamp.as_ref().map(|t| t.0),
            last_timestamp: event.last_timestamp.as_ref().map(|t| t.0),
        }
    }
}
