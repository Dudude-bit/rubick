//! ingress-nginx, detected without a single CRD.
//!
//! Every other extension in this module is found by asking whether one
//! object exists: `certificates.cert-manager.io` is in the API server or it
//! is not. ingress-nginx installs **no `CustomResourceDefinition` at all** —
//! its whole configuration lives in core `Ingress` objects and in
//! annotations on them — so there is no marker CRD to look for, and the
//! marker table cannot hold it.
//!
//! What it does have is a fact of exactly the same kind. An `IngressClass`
//! carries `spec.controller`, and that string is the implementation naming
//! *itself*: ingress-nginx writes `k8s.io/ingress-nginx` into it, and no
//! other controller may claim that name without answering for it. That is
//! not sniffing a port and not matching a workload's name — it is the same
//! declared field the app already reads to decide which Ingresses Traefik
//! serves.
//!
//! ## The second fact, and why it is second
//!
//! A controller started with `--watch-ingress-without-class` and no class of
//! its own is a real, if unusual, install, and the class check would call it
//! absent. So where no class claims the controller, the controller's own
//! workload is looked for by the label its every chart and static manifest
//! writes. That is weaker evidence than a `spec.controller` string — a label
//! is something anybody may apply — and it is therefore only ever a
//! fallback, never the thing that is asked first. It costs a second request
//! only on clusters where the first answer was no.

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::networking::v1::IngressClass;
use kube::ResourceExt;
use tauri::State;

use super::DetectedExtension;
use crate::error::Result;
use crate::state::AppState;

pub const ID: &str = "ingress-nginx";

/// The string ingress-nginx writes into `IngressClass.spec.controller`.
///
/// The same constant the frontend uses to decide which Ingresses belong on
/// its page, spelled here because detection and the page must agree: a
/// vendor row saying "detected" over a page with nothing on it would be the
/// two halves disagreeing about the same cluster.
pub const CONTROLLER: &str = "k8s.io/ingress-nginx";

/// What the project's own manifests and charts label the controller with.
const WORKLOAD_SELECTOR: &str = "app.kubernetes.io/name=ingress-nginx";

/// The label every ingress-nginx release stamps on the objects it ships.
const VERSION_LABEL: &str = "app.kubernetes.io/version";

/// Whether any of these classes is claimed by ingress-nginx, and the version
/// stamped on the one that is.
///
/// Pure, so the two shapes that matter — a cluster whose only class is
/// somebody else's, and a class with no `controller` at all — are testable
/// without a cluster.
#[must_use]
pub fn from_classes(classes: &[IngressClass]) -> Option<Option<String>> {
    let claimed = classes.iter().find(|class| {
        class
            .spec
            .as_ref()
            .and_then(|spec| spec.controller.as_deref())
            == Some(CONTROLLER)
    })?;
    Some(claimed.labels().get(VERSION_LABEL).cloned())
}

/// The version off the controller's own workload, for the class-less install.
#[must_use]
pub fn from_workloads(deployments: &[Deployment]) -> Option<Option<String>> {
    let first = deployments.first()?;
    Some(first.labels().get(VERSION_LABEL).cloned())
}

/// Is ingress-nginx installed, and which version.
pub async fn detect(state: State<'_, AppState>) -> Result<DetectedExtension> {
    let found = match detect_by_class(state.clone()).await? {
        Some(version) => Some(version),
        None => detect_by_workload(state).await?,
    };

    Ok(DetectedExtension {
        id: ID.to_string(),
        installed: found.is_some(),
        version: found.flatten(),
    })
}

async fn detect_by_class(state: State<'_, AppState>) -> Result<Option<Option<String>>> {
    let classes =
        crate::commands::helpers::list_cluster_resources::<IngressClass>(state, None, None, None)
            .await?;
    Ok(from_classes(&classes.items))
}

async fn detect_by_workload(state: State<'_, AppState>) -> Result<Option<Option<String>>> {
    let deployments = crate::commands::helpers::list_resources::<Deployment>(
        None,
        state,
        Some(WORKLOAD_SELECTOR),
        None,
        None,
    )
    .await?;
    Ok(from_workloads(&deployments.items))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::networking::v1::IngressClassSpec;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use std::collections::BTreeMap;

    fn class(name: &str, controller: Option<&str>, version: Option<&str>) -> IngressClass {
        IngressClass {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                labels: version
                    .map(|value| BTreeMap::from([(VERSION_LABEL.to_string(), value.to_string())])),
                ..Default::default()
            },
            spec: Some(IngressClassSpec {
                controller: controller.map(str::to_string),
                parameters: None,
            }),
        }
    }

    /// Would break if detection started reading the class's *name*. A class
    /// may be called anything — `public`, `internal-nginx`, `web` — and the
    /// only thing that says which implementation answers for it is the
    /// controller string.
    #[test]
    fn the_controller_string_is_what_is_looked_at_not_the_name() {
        let renamed = vec![class("public", Some(CONTROLLER), Some("1.11.3"))];
        assert_eq!(from_classes(&renamed), Some(Some("1.11.3".to_string())));

        let impostor = vec![class("nginx", Some("traefik.io/ingress-controller"), None)];
        assert_eq!(from_classes(&impostor), None);
    }

    /// Would break if a cluster whose only ingress controller is somebody
    /// else's started reporting nginx as installed — the state every k3d
    /// cluster is in, and the one where a wrong yes puts an empty page in
    /// the sidebar.
    #[test]
    fn a_cluster_with_another_controller_says_no() {
        let traefik = vec![class(
            "traefik",
            Some("traefik.io/ingress-controller"),
            Some("3.1.2"),
        )];
        assert_eq!(from_classes(&traefik), None);
        assert_eq!(from_classes(&[]), None);
    }

    /// Would break if an unlabelled install stopped being an install. The
    /// version is a nicety; whether the controller is there is the answer.
    #[test]
    fn an_unlabelled_class_is_still_an_install() {
        let bare = vec![class("nginx", Some(CONTROLLER), None)];
        assert_eq!(from_classes(&bare), Some(None));
    }

    /// Would break if a class with no `controller` field at all — which is
    /// legal YAML and is claimed by nothing — were read as a match.
    #[test]
    fn a_class_claimed_by_nobody_is_not_a_match() {
        let empty = vec![class("orphan", None, None)];
        assert_eq!(from_classes(&empty), None);
    }
}
