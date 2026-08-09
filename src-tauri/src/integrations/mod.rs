//! In-cluster extensions: detected, never configured.
//!
//! The rule that decides what belongs here is sharp enough to test. Core is
//! what the API server answers for on any cluster. An in-cluster extension
//! is something whose whole state is CRDs on that same API server — so
//! "is it there" has a yes or a no, with no address to fill in, no
//! credential to hold and nothing guessed. Anything that needs its own URL
//! is neither, and is not in this tree.
//!
//! Detection being a fact rather than a heuristic is the only reason it is
//! allowed at all. `certificates.cert-manager.io` exists as a CRD or it does
//! not; the app is not sniffing a port or matching a name.
//!
//! One folder per extension. Nothing outside this module imports one by
//! name — the frontend asks for a capability and gets an implementation or
//! nothing, and a lint rule keeps that true.

pub mod cert_manager;

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::Result;
use crate::state::AppState;

/// Whether an extension is installed in the connected cluster.
///
/// No "reachable" and no "last checked": there is nothing to reach. The
/// CRDs are in the same list the app already reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedExtension {
    pub id: String,
    pub installed: bool,
    /// What the extension labels its own CRDs with, where it labels them.
    pub version: Option<String>,
}

/// What is installed in this cluster, in one request.
#[tauri::command]
pub async fn detect_in_cluster_extensions(
    state: State<'_, AppState>,
) -> Result<Vec<DetectedExtension>> {
    let crds = crate::commands::helpers::list_cluster_resources::<CustomResourceDefinition>(
        state, None, None, None,
    )
    .await?;
    Ok(vec![cert_manager::detect(&crds.items)])
}

/// The `app.kubernetes.io/version` an extension stamps on its own CRDs.
///
/// Read off the object rather than off a Deployment's image tag: the CRDs
/// are what detection already looked at, and an operator installed by Helm,
/// by manifest or by an operator-of-operators labels them the same way.
fn version_from(crds: &[CustomResourceDefinition], name: &str) -> Option<String> {
    crds.iter()
        .find(|crd| crd.name_any() == name)?
        .labels()
        .get("app.kubernetes.io/version")
        .cloned()
}
