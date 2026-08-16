//! `ResourceContext` — bundles a Kubernetes `Client` with an
//! optional namespace scope, plus convenience constructors over
//! various namespaced/cluster `Api` shapes.

use crate::error::{Error, Result};
use crate::state::AppState;
use crate::utils::normalize_optional_namespace;
use kube::api::DynamicObject;
use kube::discovery::ApiResource;
use kube::Resource;
use kube::{Api, Client};
use tauri::State;

/// Context for Kubernetes API access with optional namespace scope.
pub struct ResourceContext {
    pub client: Client,
    pub namespace: Option<String>,
}

impl ResourceContext {
    /// Create context from `AppState`. If `require_namespace` is true,
    /// defaults to `"default"`.
    ///
    /// Both Tauri command callers (which hold `tauri::State<'_, AppState>`)
    /// and non-Tauri callers (which hold `&AppState` directly) flow through
    /// this one constructor — `State<'_, T>` derefs to `&T`, so the
    /// `for_command` / `for_list` wrappers just borrow the inner state.
    fn from_app_state(
        state: &AppState,
        namespace: Option<String>,
        require_namespace: bool,
    ) -> Result<Self> {
        let context = state
            .get_current_context()
            .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;

        let client = state
            .client_manager
            .get_client(&context)
            .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLIENT.to_string()))
            .map(|c| (*c).clone())?;

        let namespace = if require_namespace {
            Some(normalize_optional_namespace(namespace).unwrap_or_else(|| "default".to_string()))
        } else {
            normalize_optional_namespace(namespace)
        };

        Ok(ResourceContext { client, namespace })
    }

    /// Create context directly from a client (for use outside of Tauri commands)
    #[must_use]
    pub fn from_client(client: Client, namespace: String) -> Self {
        ResourceContext {
            client,
            namespace: Some(namespace),
        }
    }

    /// For single-resource commands (get/delete) - requires namespace, defaults to "default"
    pub fn for_command(state: &State<'_, AppState>, namespace: Option<String>) -> Result<Self> {
        Self::from_app_state(state, namespace, true)
    }

    /// For list commands - namespace is optional (None = all namespaces)
    pub fn for_list(state: &State<'_, AppState>, namespace: Option<String>) -> Result<Self> {
        Self::from_app_state(state, namespace, false)
    }

    /// For list commands without Tauri state - namespace is optional (None = all namespaces)
    pub fn for_list_from_app_state(state: &AppState, namespace: Option<String>) -> Result<Self> {
        Self::from_app_state(state, namespace, false)
    }

    #[must_use]
    pub fn namespaced_api<K>(&self) -> Api<K>
    where
        K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>,
        K::DynamicType: Default,
    {
        let namespace = self
            .namespace
            .as_deref()
            .expect("namespaced_api() requires namespace to be Some");
        Api::namespaced(self.client.clone(), namespace)
    }

    #[must_use]
    pub fn namespaced_or_cluster_api<K>(&self) -> Api<K>
    where
        K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>,
        K::DynamicType: Default,
    {
        if self.namespace.is_some() {
            self.namespaced_api()
        } else {
            self.cluster_api()
        }
    }

    /// Create dynamic API for a resource (without `ApiCapabilities`)
    #[must_use]
    pub fn dynamic_api_for_resource(
        &self,
        api_resource: &ApiResource,
        is_cluster_scoped: bool,
    ) -> Api<DynamicObject> {
        if is_cluster_scoped {
            Api::all_with(self.client.clone(), api_resource)
        } else {
            match self.namespace.as_deref() {
                Some(ns) => Api::namespaced_with(self.client.clone(), ns, api_resource),
                None => Api::all_with(self.client.clone(), api_resource),
            }
        }
    }

    #[must_use]
    pub fn cluster_api<K: Resource>(&self) -> Api<K>
    where
        K::DynamicType: Default,
    {
        Api::all(self.client.clone())
    }
}
