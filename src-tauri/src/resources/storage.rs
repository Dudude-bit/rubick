//! Storage resource types

use super::OptionTimeExt;
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
    /// What the cluster reported. Absent when it reported nothing —
    /// a hole the reader is told about, not filled with a word.
    pub capacity: Option<String>,
    pub access_modes: Vec<String>,
    pub reclaim_policy: Option<String>,
    pub status: String,
    pub claim: Option<String>,
    pub storage_class: String,
    pub reason: Option<String>,
    /// Carried so the app can tell a volume somebody applied from a
    /// repository from one a provisioner made. Both are on the object
    /// itself, so this costs a clone and no extra call.
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    /// When the cluster created it. The age is a word the reader
    /// sees, so it is composed where the language is known.
    pub created_at: Option<String>,
}

impl From<&PersistentVolume> for PersistentVolumeInfo {
    fn from(pv: &PersistentVolume) -> Self {
        let spec = pv.spec.as_ref();
        let status = pv.status.as_ref();

        let capacity = spec
            .and_then(|s| s.capacity.as_ref())
            .and_then(|c| c.get("storage"))
            .map(|q| q.0.clone());

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
            reclaim_policy: spec.and_then(|s| s.persistent_volume_reclaim_policy.clone()),
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
            created_at: pv.metadata.creation_timestamp.to_rfc3339_opt(),
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
    /// What the cluster reported. Absent when it reported nothing —
    /// a hole the reader is told about, not filled with a word.
    pub capacity: Option<String>,
    pub access_modes: Vec<String>,
    pub storage_class: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    /// When the cluster created it. The age is a word the reader
    /// sees, so it is composed where the language is known.
    pub created_at: Option<String>,
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
            });

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
            created_at: pvc.metadata.creation_timestamp.to_rfc3339_opt(),
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
    /// When the cluster created it. The age is a word the reader
    /// sees, so it is composed where the language is known.
    pub created_at: Option<String>,
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
            created_at: sc.metadata.creation_timestamp.to_rfc3339_opt(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;

    /// Would break if the age went back to being a word composed here. These
    /// three kinds used to send a finished string — `"5d"`, or `"Unknown"`
    /// when the cluster had stamped nothing — which reached a Russian reader
    /// in English while every other kind's age was translated. The timestamp
    /// travels; the word is chosen where the language is known.
    #[test]
    fn a_volume_the_cluster_never_stamped_sends_no_age_rather_than_a_word() {
        let pv = PersistentVolume::default();
        assert_eq!(PersistentVolumeInfo::from(&pv).created_at, None);

        let pvc = PersistentVolumeClaim::default();
        assert_eq!(PersistentVolumeClaimInfo::from(&pvc).created_at, None);

        let sc = StorageClass::default();
        assert_eq!(StorageClassInfo::from(&sc).created_at, None);
    }

    /// Would break if a field the cluster never filled came back as a word.
    /// The capacity and the reclaim policy used to arrive as `"Unknown"`,
    /// which reads as a value the cluster stated — and which the peek panel
    /// then printed instead of the "not provisioned yet" line it already
    /// had written for exactly this case, because a word is not falsy.
    #[test]
    fn a_volume_that_stated_no_size_states_none_rather_than_a_word() {
        let pv = PersistentVolume::default();
        let info = PersistentVolumeInfo::from(&pv);
        assert_eq!(info.capacity, None);
        assert_eq!(info.reclaim_policy, None);

        let pvc = PersistentVolumeClaim::default();
        assert_eq!(PersistentVolumeClaimInfo::from(&pvc).capacity, None);
    }

    /// And when it did stamp one, what travels is the stamp — not a duration
    /// frozen at the moment this process happened to read it.
    #[test]
    fn a_stamped_volume_sends_the_stamp_itself() {
        let mut pv = PersistentVolume::default();
        pv.metadata.creation_timestamp = Some(Time(
            chrono::DateTime::parse_from_rfc3339("2026-01-15T10:30:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        ));

        let sent = PersistentVolumeInfo::from(&pv).created_at.unwrap();
        assert!(sent.starts_with("2026-01-15T10:30:00"), "{sent}");
    }
}
