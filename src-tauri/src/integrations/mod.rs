//! Extensions, in two kinds that must not be confused for each other.
//!
//! **Detected.** Core is what the API server answers for on any cluster. An
//! in-cluster extension is something whose whole state is objects on that
//! same API server — so "is it there" has a yes or a no, with no address to
//! fill in, no credential to hold and nothing guessed. Detection being a
//! **fact rather than a heuristic** is the only reason it is allowed at all:
//! `certificates.cert-manager.io` exists as a CRD or it does not; the app is
//! not sniffing a port or matching a name.
//!
//! For most of them that fact is a marker CRD. For ingress-nginx there is no
//! CRD to be marked by — it installs none — and the fact is a *declared
//! field* instead: `IngressClass.spec.controller` is the implementation
//! naming itself, which is the same kind of statement and is read the same
//! way. The rule is not "a CRD"; it is "the cluster says so in a field
//! somebody had to write". [`detect_in_cluster_extensions`] answers for all
//! of them.
//!
//! **Configured.** Anything that needs its own URL, and usually a credential
//! the kubeconfig does not carry, cannot be detected without guessing — and
//! guessing at `monitoring`, at a Service named `prometheus`, at a port is
//! wrong often enough to be worse than asking. So it is an address the
//! reader gives us, per cluster, and its "is it there" is a probe rather
//! than a CRD lookup. [`prometheus`] is the first and [`loki`] the second,
//! and they hold the network half of themselves here because a bearer token
//! has no business in the webview and CORS has no business in this. What
//! they share of that half is in [`wire`].
//!
//! One folder per extension. Nothing outside this module imports one by
//! name — the frontend asks for a capability and gets an implementation or
//! nothing, and a lint rule keeps that true.

pub mod cert_manager;
pub mod ingress_nginx;
pub mod loki;
pub mod prometheus;
pub mod wire;

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
    /// `None` where the cluster would not say. A reader without rights over
    /// `CustomResourceDefinition`s cannot be told "not installed" about every
    /// extension that announces itself with one — that is a different fact,
    /// and it is not one this app is entitled to assert.
    pub installed: Option<bool>,
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
    ("argocd", &["applications.argoproj.io"]),
    // The three managed offerings' own controllers. What is detected is the
    // controller, never the cloud: a cluster cannot fail to be on GKE, but
    // it can perfectly well be on GKE with HTTP load balancing turned off,
    // and "Google Cloud · not installed" would be nonsense where "GKE
    // Ingress · not installed" is a fact.
    //
    // GKE's Ingress stack is two controllers that ship and are turned on
    // together — ingress-gce owns the two config kinds, gke-managed-certs
    // owns the certificate — so one row covers both. `BackendConfig` leads
    // because it is the one every GKE cluster with an Ingress has.
    (
        "gke-ingress",
        &[
            "backendconfigs.cloud.google.com",
            "frontendconfigs.networking.gke.io",
            "managedcertificates.networking.gke.io",
        ],
    ),
    (
        "aws-load-balancer-controller",
        &[
            "targetgroupbindings.elbv2.k8s.aws",
            "ingressclassparams.elbv2.k8s.aws",
        ],
    ),
    // Two separate AKS add-ons under one row, because the reader turns them
    // on in one place and neither is worth a row of its own. aad-pod-identity
    // is deprecated in favour of Workload Identity and is still what a great
    // many clusters run, which is exactly why it is worth reading.
    (
        "aks-addons",
        &[
            "azureidentitybindings.aadpodidentity.k8s.io",
            "azureidentities.aadpodidentity.k8s.io",
            "azureingressprohibitedtargets.appgw.ingress.k8s.io",
        ],
    ),
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
        installed: Some(found.is_some()),
        version: found.and_then(|marker| version_from(crds, marker)),
    }
}

/// What is installed in this cluster.
///
/// One request for all of the CRD-marked ones, and one more for the vendor
/// that has no CRDs to be marked by — see [`ingress_nginx`], which is
/// detected by the controller string an `IngressClass` declares rather than
/// by an object whose existence is the install.
#[tauri::command]
pub async fn detect_in_cluster_extensions(
    state: State<'_, AppState>,
) -> Result<Vec<DetectedExtension>> {
    // Each source answers for itself. One refusal used to take the whole
    // screen with it: a reader without rights over IngressClasses lost
    // cert-manager, Traefik and everything else that had answered fine.
    let crds = match crate::commands::helpers::list_cluster_resources::<CustomResourceDefinition>(
        state.clone(),
        None,
        None,
        None,
    )
    .await
    {
        Ok(list) => Some(list.items),
        // Only a refusal degrades. It is an answer about this account's
        // rights and leaves every other source worth asking. A timeout or a
        // dead connection is a fault, and dressing it as "no rights to look"
        // would send somebody to their cluster admin about a network blip.
        Err(err) if err.is_refusal() => None,
        Err(err) => return Err(err),
    };

    let mut detected = vec![match &crds {
        Some(items) => cert_manager::detect(items),
        None => unknown(cert_manager::ID),
    }];
    detected.extend(MARKERS.iter().map(|(id, markers)| match &crds {
        Some(items) => detect_by_marker(items, id, markers),
        None => unknown(id),
    }));
    detected.push(match ingress_nginx::detect(state).await {
        Ok(found) => found,
        Err(err) if err.is_refusal() => unknown(ingress_nginx::ID),
        Err(err) => return Err(err),
    });
    Ok(detected)
}

/// An extension the cluster would not answer about.
fn unknown(id: &str) -> DetectedExtension {
    DetectedExtension {
        id: id.to_string(),
        installed: None,
        version: None,
    }
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
        assert_eq!(
            detect_by_marker(&v2, "traefik", MARKERS[0].1).installed,
            Some(true)
        );

        let v3 = vec![crd("ingressroutes.traefik.io")];
        assert_eq!(
            detect_by_marker(&v3, "traefik", MARKERS[0].1).installed,
            Some(true)
        );
    }

    /// Would break if a cloud's row started depending on the whole set of
    /// its CRDs rather than on any one of them. A GKE cluster that has never
    /// been given a Google-managed certificate has no
    /// `managedcertificates.networking.gke.io` at all, and reporting the
    /// Ingress stack absent there would hide the `BackendConfigs` it does have.
    #[test]
    fn any_one_of_a_clouds_crds_is_the_install() {
        let by_id = |id: &str| MARKERS.iter().find(|(name, _)| *name == id).unwrap().1;
        for id in ["gke-ingress", "aws-load-balancer-controller", "aks-addons"] {
            for marker in by_id(id) {
                let alone = vec![crd(marker)];
                assert_eq!(
                    detect_by_marker(&alone, id, by_id(id)).installed,
                    Some(true),
                    "{id} was not detected by {marker} on its own"
                );
            }
        }
    }

    /// Would break if the clouds' markers started overlapping each other —
    /// an `elbv2.k8s.aws` CRD reported as GKE would put a row on a cluster
    /// that has nothing of the sort.
    #[test]
    fn one_clouds_crds_never_detect_another() {
        let clouds = ["gke-ingress", "aws-load-balancer-controller", "aks-addons"];
        for (id, markers) in MARKERS.iter().filter(|(id, _)| clouds.contains(id)) {
            let installed: Vec<_> = markers.iter().map(|marker| crd(marker)).collect();
            for other in clouds.iter().filter(|other| *other != id) {
                let other_markers = MARKERS.iter().find(|(n, _)| n == other).unwrap().1;
                assert_eq!(
                    detect_by_marker(&installed, other, other_markers).installed,
                    Some(false),
                    "{id}'s CRDs were read as {other}"
                );
            }
        }
    }

    /// Would break if detection started reporting every vendor as present,
    /// or if the marker list went empty for one of them.
    #[test]
    fn a_cluster_with_none_of_them_says_so() {
        let other = vec![crd("widgets.demo.k8s-gui.io")];
        for (id, markers) in MARKERS {
            assert!(!markers.is_empty(), "{id} has no marker to detect it by");
            assert_eq!(detect_by_marker(&other, id, markers).installed, Some(false));
        }
    }
}
