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

/// The extensions whose whole Rust-side knowledge is a marker CRD.
///
/// cert-manager has a folder because it has a command behind it. These
/// three have nothing but the name of the object whose existence *is* the
/// install, and three files holding one constant each would be ceremony
/// standing in for structure. The first marker present wins, so a vendor
/// that renamed its API group lists the current spelling first.
const MARKERS: &[(&str, &[&str])] = &[
    (
        "traefik",
        &[
            "ingressroutes.traefik.io",
            "ingressroutes.traefik.containo.us",
        ],
    ),
    ("flux", &["kustomizations.kustomize.toolkit.fluxcd.io"]),
    ("istio", &["virtualservices.networking.istio.io"]),
];

fn detect_by_marker(
    crds: &[CustomResourceDefinition],
    id: &str,
    markers: &[&str],
) -> DetectedExtension {
    let found = markers
        .iter()
        .find(|marker| crds.iter().any(|crd| crd.name_any() == **marker));
    DetectedExtension {
        id: id.to_string(),
        installed: found.is_some(),
        version: found.and_then(|marker| version_from(crds, marker)),
    }
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
    let mut detected = vec![cert_manager::detect(&crds.items)];
    detected.extend(
        MARKERS
            .iter()
            .map(|(id, markers)| detect_by_marker(&crds.items, id, markers)),
    );
    Ok(detected)
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

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinitionSpec;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

    fn crd(name: &str) -> CustomResourceDefinition {
        CustomResourceDefinition {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                ..Default::default()
            },
            spec: CustomResourceDefinitionSpec::default(),
            status: None,
        }
    }

    /// Would break if a Traefik that never went through the v3 migration
    /// stopped being detected — `traefik.containo.us` is the whole of what a
    /// v2 cluster serves, and reporting it absent would tell the reader the
    /// proxy in front of their cluster is not there.
    #[test]
    fn a_renamed_api_group_is_still_the_same_vendor() {
        let v2 = vec![crd("ingressroutes.traefik.containo.us")];
        assert!(detect_by_marker(&v2, "traefik", MARKERS[0].1).installed);

        let v3 = vec![crd("ingressroutes.traefik.io")];
        assert!(detect_by_marker(&v3, "traefik", MARKERS[0].1).installed);
    }

    /// Would break if detection started reporting every vendor as present,
    /// or if the marker list went empty for one of them.
    #[test]
    fn a_cluster_with_none_of_them_says_so() {
        let other = vec![crd("widgets.demo.k8s-gui.io")];
        for (id, markers) in MARKERS {
            assert!(!markers.is_empty(), "{id} has no marker to detect it by");
            assert!(!detect_by_marker(&other, id, markers).installed);
        }
    }
}
