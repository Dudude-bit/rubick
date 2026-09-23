//! What Kubernetes says about each kind the frontend registry knows, read
//! from `shared/kinds.json` — the file that registry imports its groups,
//! versions, plurals and scopes from.

use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct KindFacts {
    pub kind: String,
    /// `""` for the core group.
    pub group: String,
    pub version: String,
    pub plural: String,
    pub scope: KindScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KindScope {
    Namespaced,
    Cluster,
}

#[derive(Deserialize)]
struct KindsFile {
    kinds: Vec<KindFacts>,
}

static KINDS: LazyLock<Vec<KindFacts>> = LazyLock::new(|| {
    serde_json::from_str::<KindsFile>(include_str!("../../../shared/kinds.json"))
        .expect("shared/kinds.json is read by its own test before it ships")
        .kinds
});

/// The facts about `kind`, or `None` for a kind the registry does not know —
/// a custom resource, most often.
#[must_use]
pub fn facts_of(kind: &str) -> Option<&'static KindFacts> {
    KINDS.iter().find(|facts| facts.kind == kind)
}

#[cfg(test)]
pub(crate) fn every_kind() -> &'static [KindFacts] {
    &KINDS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::{GATEWAY_API_GROUP, READ_PREFERENCE};
    use k8s_openapi::{ClusterResourceScope, NamespaceResourceScope, Resource};

    trait Scoped {
        const SCOPE: KindScope;
    }
    impl Scoped for NamespaceResourceScope {
        const SCOPE: KindScope = KindScope::Namespaced;
    }
    impl Scoped for ClusterResourceScope {
        const SCOPE: KindScope = KindScope::Cluster;
    }

    /// Kind, group, version, plural and scope.
    type Said = (
        &'static str,
        &'static str,
        &'static str,
        &'static str,
        KindScope,
    );

    fn said_by<K: Resource>() -> Said
    where
        K::Scope: Scoped,
    {
        (
            K::KIND,
            K::GROUP,
            K::VERSION,
            K::URL_PATH_SEGMENT,
            <K::Scope as Scoped>::SCOPE,
        )
    }

    fn built_in() -> Vec<Said> {
        use k8s_openapi::api::{apps, autoscaling, batch, core, networking, policy, storage};
        use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions;
        vec![
            said_by::<core::v1::Pod>(),
            said_by::<apps::v1::Deployment>(),
            said_by::<apps::v1::ReplicaSet>(),
            said_by::<apps::v1::StatefulSet>(),
            said_by::<apps::v1::DaemonSet>(),
            said_by::<batch::v1::Job>(),
            said_by::<batch::v1::CronJob>(),
            said_by::<core::v1::ConfigMap>(),
            said_by::<core::v1::Secret>(),
            said_by::<core::v1::Service>(),
            said_by::<networking::v1::Ingress>(),
            said_by::<networking::v1::NetworkPolicy>(),
            said_by::<core::v1::PersistentVolumeClaim>(),
            said_by::<core::v1::PersistentVolume>(),
            said_by::<storage::v1::StorageClass>(),
            said_by::<core::v1::Endpoints>(),
            said_by::<core::v1::Node>(),
            said_by::<core::v1::Event>(),
            said_by::<core::v1::Namespace>(),
            said_by::<autoscaling::v2::HorizontalPodAutoscaler>(),
            said_by::<policy::v1::PodDisruptionBudget>(),
            said_by::<apiextensions::v1::CustomResourceDefinition>(),
        ]
    }

    /// The registry builds every URL, every access review and every Flux
    /// inventory id from this file. A group or plural written wrong in it
    /// is a dead link or a delivered object reported as disowned, with
    /// nothing failing; `k8s-openapi` is generated from the API itself.
    #[test]
    fn every_built_in_kind_says_what_k8s_openapi_says() {
        for (kind, group, version, plural, scope) in built_in() {
            let facts = facts_of(kind).unwrap_or_else(|| panic!("{kind} is not in the file"));
            assert_eq!(
                (
                    facts.group.as_str(),
                    facts.version.as_str(),
                    facts.plural.as_str(),
                    facts.scope
                ),
                (group, version, plural, scope),
                "{kind}"
            );
        }
    }

    /// Gateway API is not in `k8s-openapi`, and its kinds are addressed by
    /// a table of their own in the commands. The file and that table are
    /// two statements of one fact and must not become two answers.
    #[test]
    fn every_gateway_api_kind_is_addressed_as_the_commands_address_it() {
        let gateway: Vec<&KindFacts> = every_kind()
            .iter()
            .filter(|facts| facts.group == GATEWAY_API_GROUP)
            .collect();
        assert!(gateway.len() >= 7, "the Gateway API kinds left the file");
        for facts in gateway {
            let kind = facts.kind.as_str();
            assert_eq!(
                crate::commands::gateway::plural_of(kind).ok(),
                Some(facts.plural.as_str()),
                "{kind}"
            );
            assert_eq!(
                crate::commands::gateway::is_cluster_scoped(kind),
                facts.scope == KindScope::Cluster,
                "{kind}"
            );
            assert!(
                READ_PREFERENCE.contains(&facts.version.as_str()),
                "{kind} at {} is a version nothing here reads",
                facts.version
            );
        }
    }

    /// A kind added to the file lands under one of the two checks above or
    /// under neither, and under neither it is checked by nothing.
    #[test]
    fn every_kind_in_the_file_is_held_to_a_source() {
        let built_in: Vec<&str> = built_in().iter().map(|said| said.0).collect();
        for facts in every_kind() {
            assert!(
                built_in.contains(&facts.kind.as_str()) || facts.group == GATEWAY_API_GROUP,
                "{} is in shared/kinds.json and checked against nothing",
                facts.kind
            );
        }
    }
}
