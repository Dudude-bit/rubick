//! Resource serialization helpers

use serde::{Deserialize, Serialize};

/// Owner reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnerReference {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub uid: String,
    #[serde(default)]
    pub controller: Option<bool>,
    #[serde(default)]
    pub block_owner_deletion: Option<bool>,
}

/// Supported resource kinds
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    // Core resources
    Pod,
    Service,
    ConfigMap,
    Secret,
    Namespace,
    Node,
    PersistentVolume,
    PersistentVolumeClaim,
    ServiceAccount,
    Event,

    // Apps resources
    Deployment,
    ReplicaSet,
    StatefulSet,
    DaemonSet,

    // Batch resources
    Job,
    CronJob,

    // Networking
    Ingress,
    NetworkPolicy,

    // RBAC
    Role,
    RoleBinding,
    ClusterRole,
    ClusterRoleBinding,

    // Custom
    CustomResourceDefinition,
    Custom,
}

impl ResourceKind {
    /// Get the API version for this resource kind
    #[must_use]
    pub fn api_version(&self) -> &'static str {
        match self {
            ResourceKind::Pod
            | ResourceKind::Service
            | ResourceKind::ConfigMap
            | ResourceKind::Secret
            | ResourceKind::Namespace
            | ResourceKind::Node
            | ResourceKind::PersistentVolume
            | ResourceKind::PersistentVolumeClaim
            | ResourceKind::ServiceAccount
            | ResourceKind::Event => "v1",

            ResourceKind::Deployment
            | ResourceKind::ReplicaSet
            | ResourceKind::StatefulSet
            | ResourceKind::DaemonSet => "apps/v1",

            ResourceKind::Job | ResourceKind::CronJob => "batch/v1",

            ResourceKind::Ingress | ResourceKind::NetworkPolicy => "networking.k8s.io/v1",

            ResourceKind::Role | ResourceKind::RoleBinding => "rbac.authorization.k8s.io/v1",
            ResourceKind::ClusterRole | ResourceKind::ClusterRoleBinding => {
                "rbac.authorization.k8s.io/v1"
            }

            ResourceKind::CustomResourceDefinition => "apiextensions.k8s.io/v1",
            ResourceKind::Custom => "",
        }
    }

    /// Check if this is a namespaced resource
    #[must_use]
    pub fn is_namespaced(&self) -> bool {
        !matches!(
            self,
            ResourceKind::Namespace
                | ResourceKind::Node
                | ResourceKind::PersistentVolume
                | ResourceKind::ClusterRole
                | ResourceKind::ClusterRoleBinding
                | ResourceKind::CustomResourceDefinition
        )
    }

    /// Get the plural name for API calls
    #[must_use]
    pub fn plural(&self) -> &'static str {
        match self {
            ResourceKind::Pod => "pods",
            ResourceKind::Service => "services",
            ResourceKind::ConfigMap => "configmaps",
            ResourceKind::Secret => "secrets",
            ResourceKind::Namespace => "namespaces",
            ResourceKind::Node => "nodes",
            ResourceKind::PersistentVolume => "persistentvolumes",
            ResourceKind::PersistentVolumeClaim => "persistentvolumeclaims",
            ResourceKind::ServiceAccount => "serviceaccounts",
            ResourceKind::Event => "events",
            ResourceKind::Deployment => "deployments",
            ResourceKind::ReplicaSet => "replicasets",
            ResourceKind::StatefulSet => "statefulsets",
            ResourceKind::DaemonSet => "daemonsets",
            ResourceKind::Job => "jobs",
            ResourceKind::CronJob => "cronjobs",
            ResourceKind::Ingress => "ingresses",
            ResourceKind::NetworkPolicy => "networkpolicies",
            ResourceKind::Role => "roles",
            ResourceKind::RoleBinding => "rolebindings",
            ResourceKind::ClusterRole => "clusterroles",
            ResourceKind::ClusterRoleBinding => "clusterrolebindings",
            ResourceKind::CustomResourceDefinition => "customresourcedefinitions",
            ResourceKind::Custom => "",
        }
    }
}

impl std::fmt::Display for ResourceKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            ResourceKind::Pod => "Pod",
            ResourceKind::Service => "Service",
            ResourceKind::ConfigMap => "ConfigMap",
            ResourceKind::Secret => "Secret",
            ResourceKind::Namespace => "Namespace",
            ResourceKind::Node => "Node",
            ResourceKind::PersistentVolume => "PersistentVolume",
            ResourceKind::PersistentVolumeClaim => "PersistentVolumeClaim",
            ResourceKind::ServiceAccount => "ServiceAccount",
            ResourceKind::Event => "Event",
            ResourceKind::Deployment => "Deployment",
            ResourceKind::ReplicaSet => "ReplicaSet",
            ResourceKind::StatefulSet => "StatefulSet",
            ResourceKind::DaemonSet => "DaemonSet",
            ResourceKind::Job => "Job",
            ResourceKind::CronJob => "CronJob",
            ResourceKind::Ingress => "Ingress",
            ResourceKind::NetworkPolicy => "NetworkPolicy",
            ResourceKind::Role => "Role",
            ResourceKind::RoleBinding => "RoleBinding",
            ResourceKind::ClusterRole => "ClusterRole",
            ResourceKind::ClusterRoleBinding => "ClusterRoleBinding",
            ResourceKind::CustomResourceDefinition => "CustomResourceDefinition",
            ResourceKind::Custom => "Custom",
        };
        write!(f, "{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resource_kind_api_version() {
        assert_eq!(ResourceKind::Pod.api_version(), "v1");
        assert_eq!(ResourceKind::Deployment.api_version(), "apps/v1");
    }

    #[test]
    fn test_resource_kind_namespaced() {
        assert!(ResourceKind::Pod.is_namespaced());
        assert!(!ResourceKind::Namespace.is_namespaced());
        assert!(!ResourceKind::Node.is_namespaced());
    }
}
