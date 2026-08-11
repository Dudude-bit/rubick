//! Helper functions for Tauri commands.
//!
//! - `params`:     `build_list_params` / `build_label_selector`
//! - `context`:    `ResourceContext` (Client + namespace + Api factories)
//! - `namespaced`: generic get / delete / list / list-into-Info /
//!                 get-into-Info for `NamespaceResourceScope` kinds
//! - `cluster`:    same five generics for `ClusterResourceScope` kinds
//! - `yaml`:       fetch + clean-for-editor (strips server-managed
//!                 metadata fields)

mod cluster;
mod context;
mod namespaced;
mod params;
mod yaml;

pub use cluster::{
    delete_cluster_resource, get_cluster_resource, get_cluster_resource_info,
    list_cluster_resource_infos, list_cluster_resources,
};
pub use context::ResourceContext;
pub use namespaced::{
    delete_resource, get_resource, get_resource_info, list_resource_infos, list_resources,
    scale_resource,
};
pub use params::{build_label_selector, build_list_params};
pub use yaml::{clean_yaml_for_editor, get_resource_yaml};
