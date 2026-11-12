//! Whether the API server refuses the pods a controller asks for: a quota, a
//! `PodSecurity` level or a webhook keeps them from existing at all, so no
//! pod is there to tell why the workload is short.

use chrono::{DateTime, Utc};
use k8s_openapi::api::apps::v1::{DeploymentCondition, ReplicaSetCondition};
use k8s_openapi::api::core::v1::Event;

use crate::resources::EventInfo;

const FAILED_CREATE: &str = "FailedCreate";

/// What client-go's event correlator writes before a message it folded
/// several similar events into.
const COMBINED: &str = "(combined from similar events): ";

/// A condition a `ReplicaSet` sets and its Deployment copies.
pub trait ReplicaCondition {
    fn parts(&self) -> (&str, &str, Option<&str>, Option<&str>);
}

impl ReplicaCondition for DeploymentCondition {
    fn parts(&self) -> (&str, &str, Option<&str>, Option<&str>) {
        (
            &self.type_,
            &self.status,
            self.reason.as_deref(),
            self.message.as_deref(),
        )
    }
}

impl ReplicaCondition for ReplicaSetCondition {
    fn parts(&self) -> (&str, &str, Option<&str>, Option<&str>) {
        (
            &self.type_,
            &self.status,
            self.reason.as_deref(),
            self.message.as_deref(),
        )
    }
}

/// The refusal a `ReplicaSet` sets as `ReplicaFailure` and reports up to its
/// Deployment, which both controllers clear once a create gets through.
#[must_use]
pub fn replica_failure<C: ReplicaCondition>(conditions: &[C]) -> Option<String> {
    conditions
        .iter()
        .map(ReplicaCondition::parts)
        .find_map(|(type_, status, reason, said)| {
            (type_ == "ReplicaFailure" && status == "True" && reason == Some(FAILED_CREATE))
                .then(|| said.unwrap_or_default().to_string())
        })
}

/// The newest refusal the controller `uid` was given, unless a pod of its
/// was created after it: a refusal a later create got past is history.
/// `src/contracts/create-refusal-conformance.json` holds this and
/// `createRefusal` to one answer.
#[must_use]
pub fn create_refusal<'a>(
    uid: &str,
    events: impl IntoIterator<Item = &'a Event>,
    created: impl IntoIterator<Item = Option<DateTime<Utc>>>,
) -> Option<String> {
    let newest = events
        .into_iter()
        .filter(|event| {
            event.type_.as_deref() == Some("Warning")
                && event.reason.as_deref() == Some(FAILED_CREATE)
                && event.involved_object.uid.as_deref() == Some(uid)
        })
        .map(EventInfo::from)
        .max_by_key(|event| event.last_timestamp)?;
    let since = newest
        .last_timestamp
        .is_some_and(|at| created.into_iter().flatten().any(|pod| pod > at));
    (!since).then(|| {
        let said = newest.message.unwrap_or_default();
        if let Some(rest) = said.strip_prefix(COMBINED) {
            rest.to_string()
        } else {
            said
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn corpus() -> Vec<Value> {
        let file: Value = serde_json::from_str(include_str!(
            "../../../../contracts/create-refusal-conformance.json"
        ))
        .expect("corpus parses");
        file["cases"].as_array().expect("cases").clone()
    }

    fn event(case: &Value) -> Event {
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": "e", "namespace": "ns" },
            "type": case["type"],
            "reason": case["reason"],
            "message": case["message"],
            "lastTimestamp": case["lastTimestamp"],
            "involvedObject": { "uid": case["uid"] },
        }))
        .expect("event")
    }

    /// The overview reads a refusal here and every list, page and peek in
    /// `createRefusal`. Fails if the two answer one case differently.
    #[test]
    fn a_refusal_reads_as_the_corpus_says() {
        for case in corpus() {
            let events: Vec<Event> = case["events"]
                .as_array()
                .expect("events")
                .iter()
                .map(event)
                .collect();
            let created = case["podsCreated"]
                .as_array()
                .expect("pods")
                .iter()
                .map(|at| at.as_str().map(|at| at.parse().expect("date")))
                .collect::<Vec<_>>();
            assert_eq!(
                create_refusal(case["uid"].as_str().expect("uid"), &events, created),
                case["refused"].as_str().map(str::to_string),
                "{}",
                case["name"]
            );
        }
    }

    /// Fails if a `ReplicaSet` refused its pods and the Deployment above it
    /// does not say so, or if a failure to delete is told as one to create.
    #[test]
    fn a_deployment_says_what_its_replica_set_was_refused() {
        let condition = |reason: &str| DeploymentCondition {
            type_: "ReplicaFailure".to_string(),
            status: "True".to_string(),
            reason: Some(reason.to_string()),
            message: Some("pods \"web-1\" is forbidden: exceeded quota: two-pods".to_string()),
            ..DeploymentCondition::default()
        };
        assert_eq!(
            replica_failure(&[condition(FAILED_CREATE)]).as_deref(),
            Some("pods \"web-1\" is forbidden: exceeded quota: two-pods")
        );
        assert_eq!(replica_failure(&[condition("FailedDelete")]), None);
    }

    /// Fails if a `ReplicaSet`'s own page cannot tell the refusal the
    /// Deployment above it copied from it.
    #[test]
    fn a_replica_set_says_what_it_was_refused() {
        let refused = ReplicaSetCondition {
            type_: "ReplicaFailure".to_string(),
            status: "True".to_string(),
            reason: Some(FAILED_CREATE.to_string()),
            message: Some("pods \"web-1\" is forbidden: exceeded quota: two-pods".to_string()),
            ..ReplicaSetCondition::default()
        };
        assert_eq!(
            replica_failure(&[refused]).as_deref(),
            Some("pods \"web-1\" is forbidden: exceeded quota: two-pods")
        );
    }
}
