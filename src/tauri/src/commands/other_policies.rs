//! Whether policies of an engine other than Kubernetes' own are in force.
//!
//! A verdict that a `NetworkPolicy` shuts a pod is a claim about every
//! policy over it. Cilium unites its own allows with a `NetworkPolicy`'s,
//! Calico and Antrea decide in tiers that come first, and an
//! `AdminNetworkPolicy` Allow is final before a `NetworkPolicy` is read. So
//! where one of these holds an object over the same pods, the
//! `NetworkPolicy` objects alone do not say who is refused.

use futures::future::join_all;
use kube::api::{DynamicObject, ListParams};
use kube::{Api, Client, ResourceExt};
use serde::Serialize;
use tauri::State;

use crate::client::served::ServedIndex;
use crate::error::Result;
use crate::resources::OtherPolicies;
use crate::state::AppState;

/// Group, plural, and the name a reader knows the kind by. Calico's are the
/// CRDs it stores its own policies in: its aggregated `projectcalico.org`
/// lists every `NetworkPolicy` as one of its own too.
const KINDS: &[(&str, &str, &str)] = &[
    ("cilium.io", "ciliumnetworkpolicies", "CiliumNetworkPolicy"),
    (
        "cilium.io",
        "ciliumclusterwidenetworkpolicies",
        "CiliumClusterwideNetworkPolicy",
    ),
    (
        "crd.projectcalico.org",
        "networkpolicies",
        "NetworkPolicy.crd.projectcalico.org",
    ),
    (
        "crd.projectcalico.org",
        "globalnetworkpolicies",
        "GlobalNetworkPolicy.crd.projectcalico.org",
    ),
    (
        "crd.antrea.io",
        "networkpolicies",
        "NetworkPolicy.crd.antrea.io",
    ),
    (
        "crd.antrea.io",
        "clusternetworkpolicies",
        "ClusterNetworkPolicy.crd.antrea.io",
    ),
    (
        "policy.networking.k8s.io",
        "adminnetworkpolicies",
        "AdminNetworkPolicy",
    ),
    (
        "policy.networking.k8s.io",
        "clusternetworkpolicies",
        "ClusterNetworkPolicy",
    ),
];

/// One page says which namespaces hold a policy; past it, every one may.
const PAGE: u32 = 500;

enum Found {
    Nowhere,
    Everywhere,
    Within(Vec<String>),
}

/// Where a cluster's discovery is read from.
#[derive(Clone, Copy)]
pub struct Discovery<'a> {
    pub served: &'a ServedIndex,
    pub context: &'a str,
}

impl Discovery<'_> {
    /// Which of [`KINDS`] hold an object over `namespace`'s pods, or over any
    /// namespace's where it is `None`. A kind the cluster does not serve
    /// holds none. One it serves and would not list, or whose discovery
    /// failed, is counted as in force: nobody looked, and "none" is not what
    /// that means.
    pub(crate) async fn other_policies(
        self,
        client: &Client,
        namespace: Option<&str>,
    ) -> OtherPolicies {
        let reads = KINDS.iter().map(|&(group, plural, kind)| async move {
            (kind, self.holds(client, namespace, group, plural).await)
        });
        let mut others = OtherPolicies::none();
        for (kind, found) in join_all(reads).await {
            match found {
                Found::Nowhere => {}
                Found::Everywhere => others.everywhere(kind),
                Found::Within(namespaces) => {
                    for namespace in namespaces {
                        others.within(&namespace, kind);
                    }
                }
            }
        }
        others
    }

    async fn holds(
        self,
        client: &Client,
        namespace: Option<&str>,
        group: &str,
        plural: &str,
    ) -> Found {
        let served = self.served.resource(self.context, client, group, plural);
        let found = match served.await {
            Ok(None) => return Found::Nowhere,
            Ok(Some(found)) => found,
            Err(_) => return Found::Everywhere,
        };
        let here = namespace.filter(|_| found.namespaced);
        let api: Api<DynamicObject> = match here {
            Some(namespace) => Api::namespaced_with(client.clone(), namespace, &found.resource),
            None => Api::all_with(client.clone(), &found.resource),
        };
        let whole = found.namespaced && here.is_none();
        let page = ListParams::default().limit(if whole { PAGE } else { 1 });
        match api.list_metadata(&page).await {
            Err(kube::Error::Api(status)) if status.code == 404 => Found::Nowhere,
            Err(_) => Found::Everywhere,
            Ok(list) if list.items.is_empty() => Found::Nowhere,
            Ok(list) if whole && list.metadata.continue_.as_deref().unwrap_or("").is_empty() => {
                Found::Within(
                    list.items
                        .iter()
                        .filter_map(ResourceExt::namespace)
                        .collect(),
                )
            }
            Ok(_) => here.map_or(Found::Everywhere, |namespace| {
                Found::Within(vec![namespace.to_string()])
            }),
        }
    }
}

/// The other engines' policy kinds in force over one namespace's pods.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherPolicyKinds {
    pub namespace: String,
    pub kinds: Vec<String>,
}

/// For each namespace asked, in order: the other engines' policy kinds that
/// may hold a policy over its pods. What a controller's egress
/// `NetworkPolicy` objects are judged beside.
#[tauri::command]
pub async fn list_other_policy_kinds(
    namespaces: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<OtherPolicyKinds>> {
    for namespace in &namespaces {
        crate::validation::validate_dns_label(namespace)?;
    }
    let context = state.get_current_context().unwrap_or_default();
    let client = state.current_client()?;
    let discovery = state.discovery(&context);
    // One namespace apiece: a reader bound to namespaces is refused the
    // cluster-wide list, which would count every kind as in force.
    crate::client::clock::timed(&state.perf, "listOtherPolicyKinds", async {
        let kinds = join_all(
            namespaces
                .iter()
                .map(|namespace| discovery.other_policies(&client, Some(namespace))),
        )
        .await;
        Ok(namespaces
            .iter()
            .zip(kinds)
            .map(|(namespace, others)| OtherPolicyKinds {
                kinds: others.over(namespace),
                namespace: namespace.clone(),
            })
            .collect())
    })
    .await
}
