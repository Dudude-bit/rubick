//! Storage resource types

use crate::utils::format_k8s_age;
use k8s_openapi::api::core::v1::{PersistentVolume, PersistentVolumeClaim};
use k8s_openapi::api::storage::v1::StorageClass;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

fn format_access_mode(mode: &str) -> String {
    match mode {
        "ReadWriteOnce" => "RWO".to_string(),
        "ReadOnlyMany" => "ROX".to_string(),
        "ReadWriteMany" => "RWX".to_string(),
        "ReadWriteOncePod" => "RWOP".to_string(),
        _ => mode.to_string(),
    }
}

/// Information about a `PersistentVolume`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentVolumeInfo {
    pub name: String,
    pub capacity: String,
    pub access_modes: Vec<String>,
    pub reclaim_policy: String,
    pub status: String,
    pub claim: Option<String>,
    pub storage_class: String,
    pub reason: Option<String>,
    /// Carried so the app can tell a volume somebody applied from a
    /// repository from one a provisioner made. Both are on the object
    /// itself, so this costs a clone and no extra call.
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub age: String,
}

impl From<&PersistentVolume> for PersistentVolumeInfo {
    fn from(pv: &PersistentVolume) -> Self {
        let spec = pv.spec.as_ref();
        let status = pv.status.as_ref();

        let capacity = spec
            .and_then(|s| s.capacity.as_ref())
            .and_then(|c| c.get("storage"))
            .map_or_else(|| "Unknown".to_string(), |q| q.0.clone());

        let access_modes = spec
            .and_then(|s| s.access_modes.as_ref())
            .map(|modes| modes.iter().map(|m| format_access_mode(m)).collect())
            .unwrap_or_default();

        let claim = spec.and_then(|s| s.claim_ref.as_ref()).map(|c| {
            format!(
                "{}/{}",
                c.namespace.as_deref().unwrap_or(""),
                c.name.as_deref().unwrap_or("")
            )
        });

        Self {
            name: pv.name_any(),
            capacity,
            access_modes,
            reclaim_policy: spec
                .and_then(|s| s.persistent_volume_reclaim_policy.clone())
                .unwrap_or_else(|| "Unknown".to_string()),
            status: status
                .and_then(|s| s.phase.clone())
                .unwrap_or_else(|| "Unknown".to_string()),
            claim,
            storage_class: spec
                .and_then(|s| s.storage_class_name.clone())
                .unwrap_or_default(),
            reason: status.and_then(|s| s.reason.clone()),
            labels: pv.labels().clone(),
            annotations: pv.annotations().clone(),
            age: format_k8s_age(pv.metadata.creation_timestamp.as_ref()),
        }
    }
}

/// Information about a `PersistentVolumeClaim`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentVolumeClaimInfo {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub volume: Option<String>,
    pub capacity: String,
    pub access_modes: Vec<String>,
    pub storage_class: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub age: String,
}

impl From<&PersistentVolumeClaim> for PersistentVolumeClaimInfo {
    fn from(pvc: &PersistentVolumeClaim) -> Self {
        let spec = pvc.spec.as_ref();
        let status = pvc.status.as_ref();

        let capacity = status
            .and_then(|s| s.capacity.as_ref())
            .and_then(|c| c.get("storage"))
            .map(|q| q.0.clone())
            .or_else(|| {
                spec.and_then(|s| s.resources.as_ref())
                    .and_then(|r| r.requests.as_ref())
                    .and_then(|r| r.get("storage"))
                    .map(|q| q.0.clone())
            })
            .unwrap_or_else(|| "Unknown".to_string());

        let access_modes = status
            .and_then(|s| s.access_modes.as_ref())
            .or_else(|| spec.and_then(|s| s.access_modes.as_ref()))
            .map(|modes| modes.iter().map(|m| format_access_mode(m)).collect())
            .unwrap_or_default();

        Self {
            name: pvc.name_any(),
            namespace: pvc.namespace().unwrap_or_default(),
            status: status
                .and_then(|s| s.phase.clone())
                .unwrap_or_else(|| "Unknown".to_string()),
            volume: spec.and_then(|s| s.volume_name.clone()),
            capacity,
            access_modes,
            storage_class: spec
                .and_then(|s| s.storage_class_name.clone())
                .unwrap_or_default(),
            labels: pvc.labels().clone(),
            annotations: pvc.annotations().clone(),
            age: format_k8s_age(pvc.metadata.creation_timestamp.as_ref()),
        }
    }
}

/// Information about a `StorageClass`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageClassInfo {
    pub name: String,
    pub provisioner: String,
    pub reclaim_policy: String,
    pub volume_binding_mode: String,
    pub allow_volume_expansion: bool,
    pub is_default: bool,
    pub parameters: BTreeMap<String, String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub age: String,
}

impl From<&StorageClass> for StorageClassInfo {
    fn from(sc: &StorageClass) -> Self {
        let is_default = sc.metadata.annotations.as_ref().is_some_and(|ann| {
            ann.get("storageclass.kubernetes.io/is-default-class")
                .or_else(|| ann.get("storageclass.beta.kubernetes.io/is-default-class"))
                .is_some_and(|v| v == "true")
        });

        Self {
            name: sc.name_any(),
            provisioner: sc.provisioner.clone(),
            reclaim_policy: sc
                .reclaim_policy
                .clone()
                .unwrap_or_else(|| "Delete".to_string()),
            volume_binding_mode: sc
                .volume_binding_mode
                .clone()
                .unwrap_or_else(|| "Immediate".to_string()),
            allow_volume_expansion: sc.allow_volume_expansion.unwrap_or(false),
            is_default,
            parameters: sc.parameters.clone().unwrap_or_default(),
            labels: sc.labels().clone(),
            annotations: sc.annotations().clone(),
            age: format_k8s_age(sc.metadata.creation_timestamp.as_ref()),
        }
    }
}
