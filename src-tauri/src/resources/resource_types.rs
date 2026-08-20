//! Resource type definitions and utilities
//!
//! Provides a centralized enum for Kubernetes resource types with conversion utilities.

use serde::{Deserialize, Serialize};

/// Kubernetes resource types supported by the application
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
// Default serialization is PascalCase (matches Kind)
pub enum ResourceType {
    Pod,
    Deployment,
    StatefulSet,
    DaemonSet,
    Job,
    CronJob,
    ConfigMap,
    Secret,
    Service,
    Ingress,
    PersistentVolumeClaim,
    PersistentVolume,
    StorageClass,
    Endpoints,
    Node,
    Event,
    Namespace,
    CustomResourceDefinition,
}

impl ResourceType {
    /// Parse resource type from string (Strict Kind matching)
    #[must_use]
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "Pod" => Some(Self::Pod),
            "Deployment" => Some(Self::Deployment),
            "StatefulSet" => Some(Self::StatefulSet),
            "DaemonSet" => Some(Self::DaemonSet),
            "Job" => Some(Self::Job),
            "CronJob" => Some(Self::CronJob),
            "ConfigMap" => Some(Self::ConfigMap),
            "Secret" => Some(Self::Secret),
            "Service" => Some(Self::Service),
            "Ingress" => Some(Self::Ingress),
            "PersistentVolumeClaim" => Some(Self::PersistentVolumeClaim),
            "PersistentVolume" => Some(Self::PersistentVolume),
            "StorageClass" => Some(Self::StorageClass),
            "Endpoints" => Some(Self::Endpoints),
            "Node" => Some(Self::Node),
            "Event" => Some(Self::Event),
            "Namespace" => Some(Self::Namespace),
            "CustomResourceDefinition" => Some(Self::CustomResourceDefinition),
            _ => None,
        }
    }

    /// Get the Kind name (CamelCase singular)
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Pod => "Pod",
            Self::Deployment => "Deployment",
            Self::StatefulSet => "StatefulSet",
            Self::DaemonSet => "DaemonSet",
            Self::Job => "Job",
            Self::CronJob => "CronJob",
            Self::ConfigMap => "ConfigMap",
            Self::Secret => "Secret",
            Self::Service => "Service",
            Self::Ingress => "Ingress",
            Self::PersistentVolumeClaim => "PersistentVolumeClaim",
            Self::PersistentVolume => "PersistentVolume",
            Self::StorageClass => "StorageClass",
            Self::Endpoints => "Endpoints",
            Self::Node => "Node",
            Self::Event => "Event",
            Self::Namespace => "Namespace",
            Self::CustomResourceDefinition => "CustomResourceDefinition",
        }
    }

    /// Get the plural name (lowercase plural for API paths)
    #[must_use]
    pub fn plural(&self) -> &'static str {
        match self {
            Self::Pod => "pods",
            Self::Deployment => "deployments",
            Self::StatefulSet => "statefulsets",
            Self::DaemonSet => "daemonsets",
            Self::Job => "jobs",
            Self::CronJob => "cronjobs",
            Self::ConfigMap => "configmaps",
            Self::Secret => "secrets",
            Self::Service => "services",
            Self::Ingress => "ingresses",
            Self::PersistentVolumeClaim => "persistentvolumeclaims",
            Self::PersistentVolume => "persistentvolumes",
            Self::StorageClass => "storageclasses",
            Self::Endpoints => "endpoints",
            Self::Node => "nodes",
            Self::Event => "events",
            Self::Namespace => "namespaces",
            Self::CustomResourceDefinition => "customresourcedefinitions",
        }
    }

    /// Check if this is a cluster-scoped resource (not namespaced)
    #[must_use]
    pub fn is_cluster_scoped(&self) -> bool {
        matches!(
            self,
            Self::Node
                | Self::PersistentVolume
                | Self::StorageClass
                | Self::Namespace
                | Self::CustomResourceDefinition
        )
    }

    /// Get all supported resource types
    #[must_use]
    pub fn all() -> &'static [ResourceType] {
        &[
            Self::Pod,
            Self::Deployment,
            Self::StatefulSet,
            Self::DaemonSet,
            Self::Job,
            Self::CronJob,
            Self::ConfigMap,
            Self::Secret,
            Self::Service,
            Self::Ingress,
            Self::PersistentVolumeClaim,
            Self::PersistentVolume,
            Self::StorageClass,
            Self::Endpoints,
            Self::Node,
            Self::Event,
            Self::Namespace,
            Self::CustomResourceDefinition,
        ]
    }
}

impl std::fmt::Display for ResourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.kind())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_from_str() {
        assert_eq!(ResourceType::from_str("Pod"), Some(ResourceType::Pod));
        // Strict case - these should now fail (return None)
        assert_eq!(ResourceType::from_str("pods"), None);
        assert_eq!(ResourceType::from_str("pod"), None);
        assert_eq!(
            ResourceType::from_str("PersistentVolumeClaim"),
            Some(ResourceType::PersistentVolumeClaim)
        );
        assert_eq!(ResourceType::from_str("unknown"), None);
    }

    #[test]
    fn test_kind_and_plural() {
        assert_eq!(ResourceType::Pod.kind(), "Pod");
        assert_eq!(ResourceType::Pod.plural(), "pods");
        assert_eq!(ResourceType::Deployment.kind(), "Deployment");
        assert_eq!(ResourceType::Deployment.plural(), "deployments");
    }

    #[test]
    fn test_cluster_scoped() {
        assert!(ResourceType::Node.is_cluster_scoped());
        assert!(ResourceType::PersistentVolume.is_cluster_scoped());
        assert!(ResourceType::StorageClass.is_cluster_scoped());
        assert!(ResourceType::Namespace.is_cluster_scoped());
        assert!(ResourceType::CustomResourceDefinition.is_cluster_scoped());
        assert!(!ResourceType::Pod.is_cluster_scoped());
    }
}
