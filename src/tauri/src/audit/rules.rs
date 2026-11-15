//! What Audit judges, held to `src/contracts/audit-rules.json`.

use serde::{Deserialize, Serialize};

/// How much a finding costs the reader, worst first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuditSeverity {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Security,
    Reliability,
    Efficiency,
    Upgrade,
}

/// The Pod Security Standards profile a control belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Standard {
    Baseline,
    Restricted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuleId {
    PssHostProcess,
    PssHostNamespaces,
    PssPrivileged,
    PssCapabilities,
    PssHostPath,
    PssHostPorts,
    PssHostProbes,
    PssApparmor,
    PssSelinux,
    PssProcMount,
    PssSeccompUnconfined,
    PssSysctls,
    PssVolumeTypes,
    PssPrivilegeEscalation,
    PssRunAsNonRoot,
    PssRunAsUserRoot,
    PssSeccompRequired,
    PssDropCapabilities,
    RuntimeSocket,
    ConfigMapPrivateKey,
    EnvSecretLiteral,
    WritableRootFilesystem,
    ClusterAdminBinding,
    WildcardRole,
    DefaultServiceAccountToken,
    NamespaceWithoutNetworkPolicy,
    NoReadinessProbe,
    NoLivenessProbe,
    ImageTagLatest,
    SingleReplica,
    NoDisruptionBudget,
    BudgetBlocksDisruption,
    NoSpread,
    NoMemoryLimit,
    AutoscalerPinned,
    AutoscalerTargetMissing,
    NoCpuRequest,
    NoMemoryRequest,
    RemovedApiInHelmRelease,
    DeprecatedApiWriter,
    CrdVersionDeprecated,
    DeprecatedApiRequested,
    RequestsAboveUsage,
}

pub struct Rule {
    pub id: RuleId,
    pub category: Category,
    pub severity: AuditSeverity,
    pub standard: Option<Standard>,
    /// The other kinds it reads before it may answer.
    pub needs: &'static [&'static str],
}

const fn rule(
    id: RuleId,
    category: Category,
    severity: AuditSeverity,
    standard: Option<Standard>,
    needs: &'static [&'static str],
) -> Rule {
    Rule {
        id,
        category,
        severity,
        standard,
        needs,
    }
}

use AuditSeverity::{High, Low, Medium};
use Category::{Efficiency, Reliability, Security, Upgrade};
use RuleId as R;
const BASELINE: Option<Standard> = Some(Standard::Baseline);
const RESTRICTED: Option<Standard> = Some(Standard::Restricted);

pub const RULES: &[Rule] = &[
    rule(R::PssHostProcess, Security, High, BASELINE, &[]),
    rule(R::PssHostNamespaces, Security, High, BASELINE, &[]),
    rule(R::PssPrivileged, Security, High, BASELINE, &[]),
    rule(R::PssCapabilities, Security, High, BASELINE, &[]),
    rule(R::PssHostPath, Security, High, BASELINE, &[]),
    rule(R::PssHostPorts, Security, High, BASELINE, &[]),
    rule(R::PssHostProbes, Security, High, BASELINE, &[]),
    rule(R::PssApparmor, Security, High, BASELINE, &[]),
    rule(R::PssSelinux, Security, High, BASELINE, &[]),
    rule(R::PssProcMount, Security, High, BASELINE, &[]),
    rule(R::PssSeccompUnconfined, Security, High, BASELINE, &[]),
    rule(R::PssSysctls, Security, High, BASELINE, &[]),
    rule(R::PssVolumeTypes, Security, Low, RESTRICTED, &[]),
    rule(R::PssPrivilegeEscalation, Security, Low, RESTRICTED, &[]),
    rule(R::PssRunAsNonRoot, Security, Low, RESTRICTED, &[]),
    rule(R::PssRunAsUserRoot, Security, Medium, RESTRICTED, &[]),
    rule(R::PssSeccompRequired, Security, Low, RESTRICTED, &[]),
    rule(R::PssDropCapabilities, Security, Low, RESTRICTED, &[]),
    rule(R::RuntimeSocket, Security, High, None, &[]),
    rule(R::ConfigMapPrivateKey, Security, High, None, &[]),
    rule(R::EnvSecretLiteral, Security, Medium, None, &[]),
    rule(R::WritableRootFilesystem, Security, Low, None, &[]),
    rule(R::ClusterAdminBinding, Security, High, None, &[]),
    rule(R::WildcardRole, Security, High, None, &[]),
    rule(
        R::DefaultServiceAccountToken,
        Security,
        Low,
        None,
        &[SERVICE_ACCOUNT],
    ),
    rule(
        R::NamespaceWithoutNetworkPolicy,
        Security,
        Medium,
        None,
        &[POD, NETWORK_POLICY],
    ),
    rule(R::NoReadinessProbe, Reliability, Low, None, &[SERVICE]),
    rule(R::NoLivenessProbe, Reliability, Low, None, &[]),
    rule(R::ImageTagLatest, Reliability, Medium, None, &[]),
    rule(R::SingleReplica, Reliability, Low, None, &[AUTOSCALER]),
    rule(
        R::NoDisruptionBudget,
        Reliability,
        Low,
        None,
        &[AUTOSCALER, BUDGET],
    ),
    rule(R::BudgetBlocksDisruption, Reliability, Medium, None, &[]),
    rule(R::NoSpread, Reliability, Low, None, &[AUTOSCALER]),
    rule(R::NoMemoryLimit, Reliability, Medium, None, &[LIMIT_RANGE]),
    rule(R::AutoscalerPinned, Reliability, Low, None, &[]),
    rule(
        R::AutoscalerTargetMissing,
        Reliability,
        High,
        None,
        &[DEPLOYMENT, STATEFUL_SET],
    ),
    rule(R::NoCpuRequest, Efficiency, Medium, None, &[LIMIT_RANGE]),
    rule(R::NoMemoryRequest, Efficiency, Medium, None, &[LIMIT_RANGE]),
    rule(R::RemovedApiInHelmRelease, Upgrade, High, None, &[]),
    rule(R::DeprecatedApiWriter, Upgrade, Medium, None, &[]),
    rule(R::CrdVersionDeprecated, Upgrade, Low, None, &[]),
    rule(R::DeprecatedApiRequested, Upgrade, Medium, None, &[]),
    rule(R::RequestsAboveUsage, Efficiency, Low, None, &[]),
];

pub const POD: &str = "Pod";
pub const DEPLOYMENT: &str = "Deployment";
pub const STATEFUL_SET: &str = "StatefulSet";
pub const SERVICE: &str = "Service";
pub const SERVICE_ACCOUNT: &str = "ServiceAccount";
pub const NETWORK_POLICY: &str = "NetworkPolicy";
pub const AUTOSCALER: &str = "HorizontalPodAutoscaler";
pub const BUDGET: &str = "PodDisruptionBudget";
pub const LIMIT_RANGE: &str = "LimitRange";

impl RuleId {
    /// `RULES` is declared in the enum's order, which a test holds.
    #[must_use]
    pub fn rule(self) -> &'static Rule {
        &RULES[self as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend draws the rules from the contract and the backend judges
    /// with this table. Fails when the two disagree about any rule.
    #[test]
    fn the_rule_table_is_the_contract() {
        const CONTRACT: &str = include_str!("../../../contracts/audit-rules.json");
        let contract: serde_json::Value = serde_json::from_str(CONTRACT).unwrap();
        let listed = contract["rules"].as_array().unwrap();
        assert_eq!(listed.len(), RULES.len());
        for (written, rule) in listed.iter().zip(RULES) {
            let id: RuleId = serde_json::from_value(written["id"].clone()).unwrap();
            assert_eq!(id, rule.id);
            let category: Category = serde_json::from_value(written["category"].clone()).unwrap();
            assert_eq!(category, rule.category, "{id:?}");
            let severity: AuditSeverity =
                serde_json::from_value(written["severity"].clone()).unwrap();
            assert_eq!(severity, rule.severity, "{id:?}");
            let standard: Option<Standard> =
                serde_json::from_value(written["standard"].clone()).unwrap();
            assert_eq!(standard, rule.standard, "{id:?}");
            let needs: Vec<String> = serde_json::from_value(written["needs"].clone()).unwrap();
            assert_eq!(needs, rule.needs, "{id:?}");
            assert_eq!(id.rule().id, id, "RULES is out of the enum's order");
        }
        assert_eq!(contract["helmRelease"], super::super::HELM_RELEASE);
        assert_eq!(contract["deprecatedApi"], super::super::DEPRECATED_API);
    }
}
