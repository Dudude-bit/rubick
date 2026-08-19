//! Resource management module
//!
//! Provides abstractions for working with Kubernetes resources.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;

/// Extension trait for Option<Time> convenience
pub trait OptionTimeExt {
    /// Convert Option<Time> to Option<String> in RFC3339 format
    fn to_rfc3339_opt(&self) -> Option<String>;
}

impl OptionTimeExt for Option<Time> {
    fn to_rfc3339_opt(&self) -> Option<String> {
        self.as_ref().map(|t| t.0.to_rfc3339())
    }
}

impl OptionTimeExt for Option<&Time> {
    fn to_rfc3339_opt(&self) -> Option<String> {
        self.map(|t| t.0.to_rfc3339())
    }
}

mod connections;
mod gateway;
mod network;
pub mod published;
mod resource_types;
mod selector;
mod serialization;
mod storage;
mod tls;
mod types;
mod workloads;

pub use connections::*;
pub use gateway::*;
pub use network::*;
pub use published::{
    EndpointSource, PublishedEndpoint, PublishedPort, ServicePublished, UnpublishedPod,
};
pub use resource_types::ResourceType;
pub use selector::Selector;
pub use serialization::*;
pub use storage::*;
pub use tls::*;
pub use types::*;
pub use workloads::*;
