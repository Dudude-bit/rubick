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
pub mod pod_row;
pub mod probe;
pub mod service;

pub use common::{
    extract_owner_references, ConditionInfo, ContainerInfo, ContainerPhase, ContainerPortInfo,
    ContainerState, EnvFromInfo, EnvVarInfo, EnvVarSourceInfo, EnvVarSourceType, TerminationInfo,
};
pub use deployment::{
    template_container_images, ContainerImage, DeploymentContainerInfo,
    DeploymentContainerResources, DeploymentInfo, ReplicaInfo, ReplicaReservation,
    TemplateContainers,
};
pub use metadata::{ConfigMapInfo, EventInfo, InvolvedObjectInfo, NamespaceInfo, SecretInfo};
pub use node::{NodeAddressInfo, NodeInfo, NodeStatusInfo, ResourceQuantities, TaintInfo};
pub use pod::{
    mounts_of, volume_source, PodInfo, PodStatusInfo, PodVolumeInfo, VolumeMountInfo,
    VolumeObjectRef,
};
pub use pod_display::{
    condition_is_true, crash_looping, pending_since, restarts, stuck_reason, PENDING_GRACE_SECONDS,
};
pub use pod_row::{PodRow, PodRowStatus, RowContainer};
pub use probe::{ContainerProbes, ProbeHandler, ProbeInfo};
pub use service::{ServiceInfo, ServicePortInfo};
