//! Resource type definitions for frontend communication.
//!
//! Re-exports each submodule's public surface so callers continue
//! to use `crate::resources::*` (or `crate::resources::types::*`)
//! exactly as before.

pub mod common;
pub mod deployment;
pub mod metadata;
pub mod node;
pub mod pod;
pub mod pod_display;
pub mod service;

pub use common::{
    extract_owner_references, ConditionInfo, ContainerInfo, ContainerPortInfo, ContainerState,
    EnvFromInfo, EnvVarInfo, EnvVarSourceInfo, EnvVarSourceType, TerminationInfo,
};
pub use deployment::{
    DeploymentContainerInfo, DeploymentContainerResources, DeploymentInfo, ReplicaInfo,
};
pub use metadata::{ConfigMapInfo, EventInfo, InvolvedObjectInfo, NamespaceInfo, SecretInfo};
pub use node::{NodeAddressInfo, NodeInfo, NodeStatusInfo, ResourceQuantities, TaintInfo};
pub use pod::{PodInfo, PodStatusInfo};
pub use service::{ServiceInfo, ServicePortInfo};
