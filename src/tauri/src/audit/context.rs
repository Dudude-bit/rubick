//! Rules that read a template beside the other objects of its namespace:
//! Services, disruption budgets, autoscalers, `LimitRanges`, the default
//! `ServiceAccount`. A kind that went unread there makes its rules say "not
//! checked" for that object, never pass it.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::LimitRange;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;

use super::rules::{AUTOSCALER, BUDGET, LIMIT_RANGE, SERVICE_ACCOUNT};
use super::template::{token, TemplateFacts};
use super::{At, AuditFinding, AuditSeverity, RuleId, TrafficBy, Unchecked, What, Why};
use crate::resources::Selector;

/// What a namespace holds that a template's rules read, each kind as read
/// or why it was not.
#[derive(Debug, Clone)]
pub struct Beside {
    pub namespace: String,
    pub services: Result<Services, Why>,
    pub budgets: Result<Vec<Option<LabelSelector>>, Why>,
    pub autoscalers: Result<Vec<Scales>, Why>,
    pub limits: Result<Defaults, Why>,
    /// The `default` `ServiceAccount`'s `automountServiceAccountToken`.
    pub account: Result<Option<bool>, Why>,
}

/// Each Service by name, and its selector.
pub type Services = Vec<(String, BTreeMap<String, String>)>;

/// What an autoscaler scales and its floor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scales {
    pub name: String,
    pub kind: String,
    pub target: String,
    pub min: i32,
    pub max: i32,
}

/// What the namespace's `LimitRanges` fill in for a container that sets none.
/// `default` is a limit, which also becomes the request where none is set
/// (concepts/policy/limit-range, manage-resources-containers).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Defaults {
    pub cpu_request: bool,
    pub memory_request: bool,
    pub memory_limit: bool,
}

impl Defaults {
    #[must_use]
    pub fn of<'a>(ranges: impl IntoIterator<Item = &'a LimitRange>) -> Self {
        let mut defaults = Self::default();
        let items = ranges
            .into_iter()
            .filter_map(|range| range.spec.as_ref())
            .flat_map(|spec| spec.limits.iter())
            .filter(|item| item.type_ == "Container");
        for item in items {
            let has =
                |map: Option<
                    &BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>,
                >,
                 resource: &str| map.is_some_and(|map| map.contains_key(resource));
            let limit = item.default.as_ref();
            let request = item.default_request.as_ref();
            defaults.cpu_request |= has(limit, "cpu") || has(request, "cpu");
            defaults.memory_request |= has(limit, "memory") || has(request, "memory");
            defaults.memory_limit |= has(limit, "memory");
        }
        defaults
    }
}

/// A Deployment's or `StatefulSet`'s own replica count; `None` for a kind
/// replicas are not asked of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Replicated(pub Option<i32>);

/// The findings and blind rules of one template beside its namespace.
#[must_use]
pub fn beside(
    kind: &str,
    name: &str,
    facts: &TemplateFacts,
    replicas: Replicated,
    ns: &Beside,
) -> (Vec<AuditFinding>, Vec<Unchecked>) {
    let mut findings = Vec::new();
    let mut blind = Vec::new();
    let unread = |rule: RuleId, kind: &str, why: &Why| Unchecked {
        rule,
        kind: kind.to_string(),
        namespace: Some(ns.namespace.clone()),
        why: why.clone(),
    };

    if !facts.no_readiness.is_empty() {
        let (by, severity) = match &ns.services {
            Ok(services) => match services.iter().find(|(_, selector)| {
                Selector::Equality(selector).matches(&facts.labels) == Some(true)
            }) {
                Some((service, _)) => (
                    TrafficBy::Service {
                        name: service.clone(),
                    },
                    AuditSeverity::Medium,
                ),
                None => (TrafficBy::NoService, AuditSeverity::Low),
            },
            Err(why) => (
                TrafficBy::NotRead { why: why.clone() },
                AuditSeverity::Medium,
            ),
        };
        let mut what = unset_each(&facts.no_readiness, "readinessProbe");
        what.push(What::Traffic { by });
        findings.push(AuditFinding {
            rule: RuleId::NoReadinessProbe,
            severity,
            what,
        });
    }

    if facts.default_account && facts.automount != Some(false) {
        let account = match &ns.account {
            Ok(account) => Ok(*account),
            // The pod's own `true` decides without the account.
            Err(_) if facts.automount == Some(true) => Ok(None),
            Err(why) => Err(why),
        };
        match account {
            Ok(account) => findings.extend(token(facts, account).map(|by| {
                AuditFinding::of(RuleId::DefaultServiceAccountToken, vec![What::Token { by }])
            })),
            Err(why) => blind.push(unread(
                RuleId::DefaultServiceAccountToken,
                SERVICE_ACCOUNT,
                why,
            )),
        }
    }

    if let Replicated(Some(own)) = replicas {
        let floor = match &ns.autoscalers {
            Ok(autoscalers) => Ok(autoscalers
                .iter()
                .find(|hpa| hpa.kind == kind && hpa.target == name)
                .map_or((own, None, None), |hpa| {
                    (hpa.min, Some(hpa.name.clone()), Some(hpa.max))
                })),
            Err(why) => Err(why),
        };
        match floor {
            Err(why) => {
                for rule in [
                    RuleId::SingleReplica,
                    RuleId::NoSpread,
                    RuleId::NoDisruptionBudget,
                ] {
                    blind.push(unread(rule, AUTOSCALER, why));
                }
            }
            Ok((replicas, autoscaler, ceiling)) if facts.long_running && replicas > 0 => {
                let said = What::Replicas {
                    replicas,
                    autoscaler,
                    ceiling,
                };
                if replicas == 1 {
                    findings.push(AuditFinding::of(RuleId::SingleReplica, vec![said]));
                } else {
                    if !facts.spread {
                        findings.push(AuditFinding::of(RuleId::NoSpread, vec![said.clone()]));
                    }
                    match &ns.budgets {
                        Ok(budgets) => {
                            let covered = budgets.iter().any(|selector| {
                                Selector::Query(selector.as_ref()).matches(&facts.labels)
                                    == Some(true)
                            });
                            if !covered {
                                findings
                                    .push(AuditFinding::of(RuleId::NoDisruptionBudget, vec![said]));
                            }
                        }
                        Err(why) => blind.push(unread(RuleId::NoDisruptionBudget, BUDGET, why)),
                    }
                }
            }
            Ok(_) => {}
        }
    }

    for (rule, lacking, filled) in [
        (
            RuleId::NoCpuRequest,
            &facts.no_cpu_request,
            ns.limits.as_ref().map(|d| d.cpu_request),
        ),
        (
            RuleId::NoMemoryRequest,
            &facts.no_memory_request,
            ns.limits.as_ref().map(|d| d.memory_request),
        ),
        (
            RuleId::NoMemoryLimit,
            &facts.no_memory_limit,
            ns.limits.as_ref().map(|d| d.memory_limit),
        ),
    ] {
        if lacking.is_empty() {
            continue;
        }
        let field = match rule {
            RuleId::NoCpuRequest => "resources.requests.cpu",
            RuleId::NoMemoryRequest => "resources.requests.memory",
            _ => "resources.limits.memory",
        };
        match filled {
            Ok(true) => {}
            Ok(false) => findings.push(AuditFinding::of(rule, unset_each(lacking, field))),
            Err(why) => blind.push(unread(rule, LIMIT_RANGE, why)),
        }
    }

    (findings, blind)
}

fn unset_each(at: &[At], field: &str) -> Vec<What> {
    at.iter()
        .map(|at| What::Unset {
            at: Some(at.clone()),
            field: field.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::ContainerList;

    fn app() -> At {
        At {
            list: ContainerList::Containers,
            container: "app".to_string(),
        }
    }

    fn server() -> TemplateFacts {
        TemplateFacts {
            labels: BTreeMap::from([("app".to_string(), "web".to_string())]),
            long_running: true,
            spread: false,
            default_account: true,
            automount: None,
            no_readiness: vec![app()],
            no_cpu_request: vec![app()],
            no_memory_request: Vec::new(),
            no_memory_limit: Vec::new(),
        }
    }

    fn read_all() -> Beside {
        Beside {
            namespace: "shop".to_string(),
            services: Ok(Vec::new()),
            budgets: Ok(Vec::new()),
            autoscalers: Ok(Vec::new()),
            limits: Ok(Defaults::default()),
            account: Ok(None),
        }
    }

    fn refused() -> Why {
        Why::Refused {
            message: "forbidden".to_string(),
        }
    }

    fn rules(found: &(Vec<AuditFinding>, Vec<Unchecked>)) -> (Vec<RuleId>, Vec<RuleId>) {
        (
            found.0.iter().map(|f| f.rule).collect(),
            found.1.iter().map(|u| u.rule).collect(),
        )
    }

    /// Each kind a rule needs, refused in turn. Fails if a rule passes, or
    /// fires, on a kind it could not read: an empty list and a 403 are not
    /// one answer.
    #[test]
    fn a_rule_whose_kind_went_unread_says_not_checked_and_neither_passes_nor_fires() {
        type Refuse = fn(&mut Beside);
        let cases: Vec<(RuleId, &str, Refuse)> = vec![
            (RuleId::NoDisruptionBudget, BUDGET, |b| {
                b.budgets = Err(refused());
            }),
            (RuleId::SingleReplica, AUTOSCALER, |b| {
                b.autoscalers = Err(refused());
            }),
            (RuleId::NoCpuRequest, LIMIT_RANGE, |b| {
                b.limits = Err(refused());
            }),
            (RuleId::DefaultServiceAccountToken, SERVICE_ACCOUNT, |b| {
                b.account = Err(refused());
            }),
        ];
        for (rule, kind, refuse) in cases {
            let replicas = if rule == RuleId::SingleReplica { 1 } else { 3 };
            let mut ns = read_all();
            let fired = rules(&beside(
                "Deployment",
                "web",
                &server(),
                Replicated(Some(replicas)),
                &ns,
            ));
            assert!(fired.0.contains(&rule), "{rule:?} does not fire when read");
            refuse(&mut ns);
            let found = beside(
                "Deployment",
                "web",
                &server(),
                Replicated(Some(replicas)),
                &ns,
            );
            let (fired, blind) = rules(&found);
            assert!(!fired.contains(&rule), "{rule:?} fired on an unread {kind}");
            assert!(blind.contains(&rule), "{rule:?} passed on an unread {kind}");
            assert!(found.1.iter().any(|u| u.kind == kind));
        }
    }

    /// A missing readiness probe matters most where a Service sends
    /// traffic. Fails if the Service is not named, the cost is not lowered
    /// where none selects the pods, or an unread Service list lowers it.
    #[test]
    fn a_missing_readiness_probe_costs_more_behind_a_service() {
        let severity = |ns: &Beside| {
            let (found, _) = beside("Deployment", "web", &server(), Replicated(Some(2)), ns);
            let readiness = found
                .into_iter()
                .find(|f| f.rule == RuleId::NoReadinessProbe)
                .unwrap();
            (readiness.severity, readiness.what.last().cloned())
        };
        let mut ns = read_all();
        assert_eq!(
            severity(&ns),
            (
                AuditSeverity::Low,
                Some(What::Traffic {
                    by: TrafficBy::NoService
                })
            )
        );
        ns.services = Ok(vec![(
            "web".to_string(),
            BTreeMap::from([("app".to_string(), "web".to_string())]),
        )]);
        assert_eq!(severity(&ns).0, AuditSeverity::Medium);
        ns.services = Err(refused());
        assert_eq!(
            severity(&ns),
            (
                AuditSeverity::Medium,
                Some(What::Traffic {
                    by: TrafficBy::NotRead { why: refused() }
                })
            )
        );
    }

    /// The autoscaler's floor is the replica count that matters. Fails if a
    /// Deployment at 1 an autoscaler keeps at 3 is called single.
    #[test]
    fn an_autoscalers_floor_decides_the_replica_rules() {
        let mut ns = read_all();
        ns.autoscalers = Ok(vec![Scales {
            name: "web".to_string(),
            kind: "Deployment".to_string(),
            target: "web".to_string(),
            min: 3,
            max: 6,
        }]);
        let (fired, _) = rules(&beside(
            "Deployment",
            "web",
            &server(),
            Replicated(Some(1)),
            &ns,
        ));
        assert!(!fired.contains(&RuleId::SingleReplica));
        assert!(fired.contains(&RuleId::NoDisruptionBudget));

        // Kept at one by an autoscaler that also stops at one: the fix moves
        // both, so the finding carries the ceiling.
        ns.autoscalers = Ok(vec![Scales {
            name: "web".to_string(),
            kind: "Deployment".to_string(),
            target: "web".to_string(),
            min: 1,
            max: 1,
        }]);
        let (found, _) = beside("Deployment", "web", &server(), Replicated(Some(3)), &ns);
        let single = found
            .iter()
            .find(|f| f.rule == RuleId::SingleReplica)
            .expect("single");
        assert_eq!(
            single.what,
            vec![What::Replicas {
                replicas: 1,
                autoscaler: Some("web".to_string()),
                ceiling: Some(1),
            }]
        );
    }

    /// A `LimitRange` default fills what the template leaves out. Fails if a
    /// request it fills is still reported missing.
    #[test]
    fn a_limit_range_default_fills_a_missing_request() {
        let mut ns = read_all();
        ns.limits = Ok(Defaults {
            cpu_request: true,
            ..Defaults::default()
        });
        let (fired, blind) = rules(&beside(
            "Deployment",
            "web",
            &server(),
            Replicated(Some(2)),
            &ns,
        ));
        assert!(!fired.contains(&RuleId::NoCpuRequest));
        assert!(!blind.contains(&RuleId::NoCpuRequest));
    }

    /// A budget whose selector matches the template's labels covers it.
    #[test]
    fn a_budget_selecting_the_template_covers_it() {
        let mut ns = read_all();
        ns.budgets = Ok(vec![Some(LabelSelector {
            match_labels: Some(BTreeMap::from([("app".to_string(), "web".to_string())])),
            ..LabelSelector::default()
        })]);
        let (fired, _) = rules(&beside(
            "Deployment",
            "web",
            &server(),
            Replicated(Some(2)),
            &ns,
        ));
        assert!(!fired.contains(&RuleId::NoDisruptionBudget));
    }
}
