//! Requests far above measured use. The verdict is the webview's: it reads
//! each workload's day of usage with the Cost page's own query and judges it
//! with the Cost page's own `overRequested(efficiencyOf(..))`
//! (src/ui/lib/efficiency.ts), and sends what it found with the question.
//! Audit sets no threshold and asks no query of its own, and keeps none of
//! it past the answer it was sent with, so the Cost page's efficiency column
//! and this rule cannot disagree about a workload.

use serde::{Deserialize, Serialize};

use super::answer::{Audited, ObjectAudit, World};
use super::{AuditFinding, RuleId, Subject, Unchecked, What, Why};

/// The kinds the rule asks about wherever usage was not read: every kind
/// whose pod template Audit judges, and a pod judged on its own.
const WORKLOADS: [&str; 6] = [
    "Deployment",
    "StatefulSet",
    "DaemonSet",
    "Job",
    "CronJob",
    "Pod",
];

/// What the webview read of the scope's usage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UsageRead {
    /// Nothing keeps usage history for this cluster: no Prometheus connected.
    NoSupplier,
    /// The supplier is still being probed, or its answer has not come.
    Reading,
    /// The supplier, or the list of what each workload requests, did not answer.
    Failed { said: String },
    Read {
        /// The window usage was read over, as the Cost page words it.
        window: String,
        workloads: Vec<WorkloadUse>,
        /// Namespaces whose pods, and so whose requests, were not read.
        unread: Vec<UnreadPods>,
        /// Workloads past the row cap of the requests list, read only as a sum.
        folded: u32,
    },
}

/// One workload of the requests list, and what its usage said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadUse {
    pub namespace: String,
    pub kind: String,
    pub name: String,
    pub verdict: UseVerdict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum UseVerdict {
    /// The peak stayed under the share of the request the Cost page names.
    Over {
        cpu: Option<OverBy>,
        memory: Option<OverBy>,
    },
    /// Measured, and not over; or requesting nothing, so with no ratio.
    Within,
    /// The supplier holds no sample of its pods in the window.
    NoSamples,
    /// Measured, but its youngest pod, started at `since` where that is
    /// known, has not been seen to run the whole window: a peak of fewer
    /// hours is not judged.
    Young { since: Option<String> },
}

/// A request and the peak of what was used under it: millicores, or bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverBy {
    pub requested: u64,
    pub peak: u64,
    /// The peak is each pod's own peak summed: the workload's was no higher.
    pub at_most: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadPods {
    pub namespace: String,
    pub message: String,
}

/// Where the rule stands for the summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum UsageState {
    NoSupplier,
    Reading,
    Failed { said: String },
    Read { window: String },
}

#[must_use]
pub fn state_of(read: Option<&UsageRead>) -> UsageState {
    match read {
        None | Some(UsageRead::Reading) => UsageState::Reading,
        Some(UsageRead::NoSupplier) => UsageState::NoSupplier,
        Some(UsageRead::Failed { said }) => UsageState::Failed { said: said.clone() },
        Some(UsageRead::Read { window, .. }) => UsageState::Read {
            window: window.clone(),
        },
    }
}

fn blind(subject: &Subject, why: Why) -> Unchecked {
    Unchecked {
        rule: RuleId::RequestsAboveUsage,
        kind: "Pod".to_string(),
        namespace: subject.namespace.clone(),
        why,
    }
}

/// What the rule says of one object: a finding, a reason it could not say,
/// or nothing. Not one of the states that did not read usage is a pass.
#[must_use]
pub fn judge(
    subject: &Subject,
    read: Option<&UsageRead>,
) -> (Option<AuditFinding>, Option<Unchecked>) {
    let Some(namespace) = subject.namespace.as_deref() else {
        return (None, None);
    };
    let workload = WORKLOADS.contains(&subject.kind.as_str());
    let why = match read {
        None | Some(UsageRead::Reading) => Why::Reading,
        Some(UsageRead::NoSupplier) => Why::NoUsage,
        Some(UsageRead::Failed { said }) => Why::Failed {
            message: said.clone(),
        },
        Some(UsageRead::Read {
            workloads,
            unread,
            folded,
            ..
        }) => {
            let found = workloads.iter().find(|w| {
                w.namespace == namespace && w.kind == subject.kind && w.name == subject.name
            });
            match found.map(|w| &w.verdict) {
                Some(UseVerdict::Over { cpu, memory }) => {
                    let what = [("cpu", cpu), ("memory", memory)]
                        .into_iter()
                        .filter_map(|(resource, by)| {
                            by.as_ref().map(|by| What::OverRequested {
                                resource: resource.to_string(),
                                requested: by.requested,
                                peak: by.peak,
                                at_most: by.at_most,
                            })
                        })
                        .collect();
                    return (
                        Some(AuditFinding::of(RuleId::RequestsAboveUsage, what)),
                        None,
                    );
                }
                Some(UseVerdict::Within) => return (None, None),
                Some(UseVerdict::NoSamples) => Why::NoSamples,
                Some(UseVerdict::Young { since }) => Why::Young {
                    since: since.clone(),
                },
                None if !workload => return (None, None),
                None => match unread.iter().find(|u| u.namespace == namespace) {
                    Some(gone) => Why::Failed {
                        message: gone.message.clone(),
                    },
                    None if *folded > 0 => Why::Folded,
                    // Its pods were read and none holds a request: nothing to weigh.
                    None => return (None, None),
                },
            }
        }
    };
    if workload {
        (None, Some(blind(subject, why)))
    } else {
        (None, None)
    }
}

fn into(
    subject: &Subject,
    findings: &mut Vec<AuditFinding>,
    blinds: &mut Vec<Unchecked>,
    read: Option<&UsageRead>,
) {
    let (finding, unchecked) = judge(subject, read);
    if let Some(finding) = finding {
        findings.push(finding);
        findings.sort_by_key(|f| (f.severity, f.rule));
    }
    if let Some(unchecked) = unchecked {
        blinds.push(unchecked);
        blinds.sort_by_key(|u| u.rule);
    }
}

/// Puts what the webview read into a world before it is counted and paged,
/// so the summary, the rows and every page of them come from one answer.
pub fn merge(world: &mut World, read: Option<&UsageRead>) {
    world.usage = Some(state_of(read));
    for Audited {
        subject,
        findings,
        unchecked,
        ..
    } in &mut world.objects
    {
        into(subject, findings, unchecked, read);
    }
}

/// The same for one object's answer, for its tab and peek.
pub fn apply(audit: &mut ObjectAudit, read: Option<&UsageRead>) {
    if audit.judged_on.is_none() {
        into(
            &audit.subject,
            &mut audit.findings,
            &mut audit.unchecked,
            read,
        );
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::audit::answer::{page, AuditQuery, AuditRow};
    use crate::audit::AuditSeverity;

    fn subject(kind: &str, namespace: Option<&str>, name: &str) -> Subject {
        Subject {
            kind: kind.to_string(),
            namespace: namespace.map(str::to_string),
            name: name.to_string(),
        }
    }

    /// What the webview sends, in the shape its generated type gives it.
    fn read() -> UsageRead {
        serde_json::from_value(json!({
            "state": "read", "window": "24h",
            "workloads": [
                { "namespace": "shop", "kind": "Deployment", "name": "web",
                  "verdict": { "says": "over", "cpu": { "requested": 2000, "peak": 300, "atMost": true }, "memory": null } },
                { "namespace": "shop", "kind": "Deployment", "name": "api", "verdict": { "says": "within" } },
                { "namespace": "shop", "kind": "CronJob", "name": "nightly", "verdict": { "says": "noSamples" } },
                { "namespace": "shop", "kind": "Deployment", "name": "fresh",
                  "verdict": { "says": "young", "since": "2026-11-15T10:00:00Z" } },
            ],
            "unread": [{ "namespace": "bank", "message": "pods is forbidden" }],
            "folded": 0,
        }))
        .expect("the webview's shape")
    }

    /// The verdict the webview sent is the finding; a workload measured and
    /// within is nothing; one with no samples, one too young for a day's
    /// peak, one whose namespace's pods went unread, and every workload while
    /// usage is unread, unsupplied or failed is not checked, never passed. Would break if any state that
    /// did not read usage read as "not over".
    #[test]
    fn a_workload_is_over_only_as_the_webview_judged_it_and_unread_is_never_a_pass() {
        let usage = read();
        let (over, _) = judge(&subject("Deployment", Some("shop"), "web"), Some(&usage));
        let over = over.expect("a finding");
        assert_eq!(over.rule, RuleId::RequestsAboveUsage);
        assert_eq!(over.severity, AuditSeverity::Low);
        assert_eq!(
            over.what,
            vec![What::OverRequested {
                resource: "cpu".into(),
                requested: 2000,
                peak: 300,
                at_most: true
            }]
        );
        assert_eq!(
            judge(&subject("Deployment", Some("shop"), "api"), Some(&usage)),
            (None, None)
        );
        let why = |s: &Subject, read: Option<&UsageRead>| judge(s, read).1.map(|u| u.why);
        let nightly = subject("CronJob", Some("shop"), "nightly");
        assert_eq!(why(&nightly, Some(&usage)), Some(Why::NoSamples));
        let fresh = subject("Deployment", Some("shop"), "fresh");
        assert_eq!(
            why(&fresh, Some(&usage)),
            Some(Why::Young {
                since: Some("2026-11-15T10:00:00Z".into())
            })
        );
        let teller = subject("Deployment", Some("bank"), "teller");
        assert_eq!(
            why(&teller, Some(&usage)),
            Some(Why::Failed {
                message: "pods is forbidden".into()
            })
        );
        let web = subject("Deployment", Some("shop"), "web");
        assert_eq!(why(&web, None), Some(Why::Reading));
        assert_eq!(why(&web, Some(&UsageRead::Reading)), Some(Why::Reading));
        assert_eq!(why(&web, Some(&UsageRead::NoSupplier)), Some(Why::NoUsage));
        assert_eq!(
            why(
                &web,
                Some(&UsageRead::Failed {
                    said: "timeout".into()
                })
            ),
            Some(Why::Failed {
                message: "timeout".into()
            })
        );
        let config = subject("ConfigMap", Some("shop"), "web");
        assert_eq!(judge(&config, Some(&UsageRead::NoSupplier)), (None, None));
        assert_eq!(
            judge(&subject("Deployment", None, "web"), None),
            (None, None)
        );
    }

    /// A workload the requests list left out is nothing where its namespace
    /// was read whole, since it requests nothing now, and not checked where
    /// the list folded workloads past its cap into a sum. Would break if a
    /// workload past the cap read as within its requests.
    #[test]
    fn a_workload_the_requests_list_did_not_name_is_weighed_by_why() {
        let quiet = subject("Deployment", Some("shop"), "idle");
        assert_eq!(judge(&quiet, Some(&read())), (None, None));
        let mut capped = read();
        if let UsageRead::Read { folded, .. } = &mut capped {
            *folded = 40;
        }
        assert_eq!(
            judge(&quiet, Some(&capped)).1.map(|u| u.why),
            Some(Why::Folded)
        );
    }

    fn audited(kind: &str, name: &str) -> Audited {
        Audited {
            subject: subject(kind, Some("shop"), name),
            system: false,
            findings: Vec::new(),
            unchecked: Vec::new(),
        }
    }

    /// Merged before the world is counted, the rule is in the summary's
    /// counts, its row and its opened page alike, and the summary says where
    /// usage stands. Would break if the finding were added after the counts.
    #[test]
    fn the_rule_is_counted_with_the_rest_of_the_page() {
        let mut world = World {
            objects: vec![
                audited("Deployment", "web"),
                audited("Deployment", "api"),
                audited("CronJob", "nightly"),
            ],
            ..World::default()
        };
        merge(&mut world, Some(&read()));
        let query: AuditQuery = serde_json::from_value(json!({ "by": "rule" })).unwrap();
        let answer = page(&world, &query, 1, Vec::new());
        assert_eq!(answer.summary.findings, 1);
        assert_eq!(answer.summary.severities.low, 1);
        assert_eq!(answer.summary.categories.efficiency, 1);
        assert_eq!(
            answer.summary.usage,
            Some(UsageState::Read {
                window: "24h".into()
            })
        );
        let count = answer
            .summary
            .rules
            .iter()
            .find(|r| r.rule == RuleId::RequestsAboveUsage)
            .expect("counted");
        assert_eq!((count.objects, count.unchecked), (1, 1));
        assert!(answer.rows.iter().any(|row| matches!(
            row,
            AuditRow::Rule {
                rule: RuleId::RequestsAboveUsage,
                objects: 1,
                unchecked: 1,
                ..
            }
        )));
    }

    /// One object's answer takes the same verdict, unless the object is
    /// judged as another, whose answer carries it. Would break if a pod of
    /// a Deployment repeated the Deployment's finding on its own tab.
    #[test]
    fn one_objects_answer_takes_its_own_verdict_and_a_pod_judged_elsewhere_none() {
        let mut web = ObjectAudit {
            subject: subject("Deployment", Some("shop"), "web"),
            system: false,
            findings: Vec::new(),
            unchecked: Vec::new(),
            judged_on: None,
        };
        apply(&mut web, Some(&read()));
        assert_eq!(web.findings.len(), 1);
        let mut pod = ObjectAudit {
            subject: subject("Pod", Some("shop"), "web-0"),
            judged_on: Some(subject("Deployment", Some("shop"), "web")),
            ..web.clone()
        };
        pod.findings.clear();
        apply(&mut pod, Some(&UsageRead::NoSupplier));
        assert!(pod.findings.is_empty() && pod.unchecked.is_empty());
    }
}
