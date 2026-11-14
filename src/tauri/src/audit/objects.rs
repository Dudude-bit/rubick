//! Rules about one object that is not a pod template: a `ConfigMap`, a role,
//! a binding, an autoscaler, a disruption budget.

use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::core::v1::ConfigMap;
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::{PolicyRule, RoleRef, Subject as RbacSubject};

use super::{is_system_namespace, AuditFinding, RuleId, What};
use crate::resources::{shown_text, withhold_reason};

/// Every key of a `ConfigMap` that holds a private key, by name and by the
/// net that caught it; never the value. The same nets withhold it from the
/// Data tab, the YAML tab and a shared file.
#[must_use]
pub fn config_map(config: &ConfigMap) -> Vec<AuditFinding> {
    let mut keys: Vec<What> = Vec::new();
    let text = config.data.iter().flatten().map(|(k, v)| (k, v.as_bytes()));
    let binary = config
        .binary_data
        .iter()
        .flatten()
        .map(|(k, v)| (k, v.0.as_slice()));
    for (key, bytes) in text.chain(binary) {
        if let Some(net) = withhold_reason("", key, bytes) {
            keys.push(What::Key {
                key: shown_text(key),
                net,
            });
        }
    }
    finding_if(RuleId::ConfigMapPrivateKey, keys)
}

fn finding_if(rule: RuleId, what: Vec<What>) -> Vec<AuditFinding> {
    if what.is_empty() {
        Vec::new()
    } else {
        vec![AuditFinding::of(rule, what)]
    }
}

/// Every rule of a role granting every verb on every resource.
#[must_use]
pub fn role(rules: Option<&Vec<PolicyRule>>) -> Vec<AuditFinding> {
    let star = |list: Option<&Vec<String>>| list.is_some_and(|list| list.iter().any(|v| v == "*"));
    let what = rules
        .into_iter()
        .flatten()
        .filter(|rule| star(Some(&rule.verbs)) && star(rule.resources.as_ref()))
        .map(|rule| What::Wildcard {
            groups: rule.api_groups.clone().unwrap_or_default(),
        })
        .collect();
    finding_if(RuleId::WildcardRole, what)
}

/// A subject Kubernetes itself grants: a `system:` user or group, or a
/// `ServiceAccount` in a `kube-` namespace.
fn the_systems(subject: &RbacSubject) -> bool {
    match subject.kind.as_str() {
        "ServiceAccount" => subject
            .namespace
            .as_deref()
            .is_some_and(is_system_namespace),
        _ => subject.name.starts_with("system:"),
    }
}

/// Every subject a binding grants `cluster-admin` to that is not the
/// system's own. `namespace` is a `RoleBinding`'s, which its `ServiceAccount`
/// subjects default to.
#[must_use]
pub fn binding(
    role: &RoleRef,
    subjects: Option<&Vec<RbacSubject>>,
    namespace: Option<&str>,
) -> Vec<AuditFinding> {
    if role.kind != "ClusterRole" || role.name != "cluster-admin" {
        return Vec::new();
    }
    let what = subjects
        .into_iter()
        .flatten()
        .map(|subject| RbacSubject {
            namespace: subject.namespace.clone().or_else(|| {
                (subject.kind == "ServiceAccount")
                    .then(|| namespace.map(str::to_string))
                    .flatten()
            }),
            ..subject.clone()
        })
        .filter(|subject| !the_systems(subject))
        .map(|subject| What::Subject {
            kind: subject.kind,
            name: shown_text(&subject.name),
            namespace: subject.namespace,
            role: role.name.clone(),
        })
        .collect();
    finding_if(RuleId::ClusterAdminBinding, what)
}

/// An autoscaler whose floor is its ceiling scales nothing.
#[must_use]
pub fn autoscaler(hpa: &HorizontalPodAutoscaler) -> Vec<AuditFinding> {
    let Some(spec) = hpa.spec.as_ref() else {
        return Vec::new();
    };
    let min = spec.min_replicas.unwrap_or(1);
    if min == spec.max_replicas {
        vec![AuditFinding::of(
            RuleId::AutoscalerPinned,
            vec![What::Range {
                min,
                max: spec.max_replicas,
            }],
        )]
    } else {
        Vec::new()
    }
}

/// A budget that allows no eviction even with every pod it selects healthy,
/// read as the drain dialog and the workload pages read it.
#[must_use]
pub fn budget(pdb: &PodDisruptionBudget) -> Vec<AuditFinding> {
    let Some(status) = pdb.status.as_ref() else {
        return Vec::new();
    };
    if crate::resources::disruption::cannot_allow(status.desired_healthy, status.expected_pods) {
        vec![AuditFinding::of(
            RuleId::BudgetBlocksDisruption,
            vec![What::Budget {
                required: status.desired_healthy,
                selected: status.expected_pods,
            }],
        )]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A key built at run time, so no secret-shaped literal sits in the source.
    fn private_key_pem() -> String {
        let label = ["PRIV", "ATE KEY"].concat();
        format!("-----BEGIN {label}-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA\n-----END {label}-----\n")
    }

    /// The key is named and its value never travels. Fails if a private key
    /// is missed, a certificate beside it is called one, or the PEM is on the wire.
    #[test]
    fn a_config_map_key_holding_a_private_key_is_named_without_its_value() {
        let pem = private_key_pem();
        let config: ConfigMap = serde_json::from_value(json!({
            "metadata": { "name": "app" },
            "data": { "server.pem": pem, "ca.crt": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" }
        }))
        .unwrap();
        let findings = config_map(&config);
        assert_eq!(findings.len(), 1);
        let keys: Vec<&What> = findings[0].what.iter().collect();
        assert!(matches!(keys.as_slice(), [What::Key { key, .. }] if key == "server.pem"));
        assert!(!serde_json::to_string(&findings)
            .unwrap()
            .contains("MIIBVgIBADAN"));
    }

    /// Fails if a role is flagged for a wildcard on one side only.
    #[test]
    fn only_every_verb_on_every_resource_is_a_wildcard_role() {
        let rules = |verbs: &[&str], resources: &[&str]| -> Vec<PolicyRule> {
            vec![serde_json::from_value(json!({
                "apiGroups": ["*"], "verbs": verbs, "resources": resources
            }))
            .unwrap()]
        };
        assert_eq!(role(Some(&rules(&["*"], &["*"]))).len(), 1);
        assert!(role(Some(&rules(&["get", "list"], &["*"]))).is_empty());
        assert!(role(Some(&rules(&["*"], &["pods"]))).is_empty());
    }

    /// The default binding of `system:masters`, and a kube-system account,
    /// are the system's own. Fails if they are flagged, or a chart's account
    /// bound to cluster-admin is not.
    #[test]
    fn a_cluster_admin_binding_names_only_subjects_that_are_not_the_systems() {
        let role: RoleRef = serde_json::from_value(json!({
            "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "cluster-admin"
        }))
        .unwrap();
        let subjects: Vec<RbacSubject> = serde_json::from_value(json!([
            { "kind": "Group", "name": "system:masters" },
            { "kind": "ServiceAccount", "name": "addon", "namespace": "kube-system" },
            { "kind": "ServiceAccount", "name": "installer" }
        ]))
        .unwrap();
        let findings = binding(&role, Some(&subjects), Some("tools"));
        assert_eq!(
            findings[0].what,
            vec![What::Subject {
                kind: "ServiceAccount".to_string(),
                name: "installer".to_string(),
                namespace: Some("tools".to_string()),
                role: "cluster-admin".to_string()
            }]
        );
        let only_system = &subjects[..2];
        assert!(binding(&role, Some(&only_system.to_vec()), None).is_empty());
    }
}
