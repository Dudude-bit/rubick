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
    extract_owner_references, ConditionInfo, ContainerInfo, ContainerPhase, ContainerPortInfo,
    ContainerState, EnvFromInfo, EnvVarInfo, EnvVarSourceInfo, EnvVarSourceType, TerminationInfo,
};
pub use deployment::{
    DeploymentContainerInfo, DeploymentContainerResources, DeploymentInfo, ReplicaInfo,
    TemplateContainers,
};
pub use metadata::{ConfigMapInfo, EventInfo, InvolvedObjectInfo, NamespaceInfo, SecretInfo};
pub use node::{NodeAddressInfo, NodeInfo, NodeStatusInfo, ResourceQuantities, TaintInfo};
pub use pod::{
    mounts_of, volume_source, PodInfo, PodStatusInfo, PodVolumeInfo, VolumeMountInfo,
    VolumeObjectRef,
};
pub use pod_display::{condition_is_true, restarts};
pub use service::{ServiceInfo, ServicePortInfo};
