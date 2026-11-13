//! A probe the kubelet says fails, on a pod whose containers restart. The
//! Overview's row reads it here; a pod's page reads `probeFailure` in
//! `src/ui/lib/probe-failure.ts`, and `src/contracts/probe-failure-conformance.json`
//! holds the two to one answer.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::{ContainerRestarts, EventInfo};

/// How long a probe failure the kubelet reported still counts.
pub const PROBE_WINDOW_MINUTES: i64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeKind {
    Liveness,
    Readiness,
    Startup,
}

/// The newest probe failure inside the window, told against the container that restarts most.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeFailure {
    pub container: String,
    pub probe: ProbeKind,
    pub restarts: i32,
    /// The kubelet's sentence, as written.
    pub said: String,
    /// When the kubelet first reported it.
    pub since: Option<DateTime<Utc>>,
}

fn probe_of(message: &str) -> Option<ProbeKind> {
    let lower = message.to_ascii_lowercase();
    [
        ("liveness", ProbeKind::Liveness),
        ("readiness", ProbeKind::Readiness),
        ("startup", ProbeKind::Startup),
    ]
    .into_iter()
    .find_map(|(word, kind)| {
        lower
            .strip_prefix(word)
            .is_some_and(|rest| rest.starts_with(" probe failed"))
            .then_some(kind)
    })
}

fn seen(event: &EventInfo) -> Option<DateTime<Utc>> {
    event.last_timestamp.or(event.first_timestamp)
}

/// What the events about one pod say of its probes, given the restarts of
/// the containers a probe runs in; nothing where none restarted, where no
/// probe failed inside the window, and where the events were never read.
#[must_use]
pub fn probe_failure<'a>(
    containers: &[ContainerRestarts],
    events: impl IntoIterator<Item = &'a EventInfo>,
    now: DateTime<Utc>,
) -> Option<ProbeFailure> {
    let restarted =
        containers
            .iter()
            .filter(|c| c.n > 0)
            .reduce(|most, next| if next.n > most.n { next } else { most })?;
    let cutoff = now - Duration::minutes(PROBE_WINDOW_MINUTES);
    let (event, probe) = events
        .into_iter()
        .filter(|e| e.type_ == "Warning" && e.reason.as_deref() == Some("Unhealthy"))
        .filter(|e| seen(e).is_none_or(|at| at >= cutoff))
        .filter_map(|e| Some((e, probe_of(e.message.as_deref()?)?)))
        .reduce(|newest, next| {
            if seen(next.0) > seen(newest.0) {
                next
            } else {
                newest
            }
        })?;
    Some(ProbeFailure {
        container: restarted.container.clone(),
        probe,
        restarts: restarted.n,
        said: event.message.clone().unwrap_or_default(),
        since: event.first_timestamp.or(event.last_timestamp),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::InvolvedObjectInfo;
    use serde_json::Value;

    const FILE: &str = include_str!("../../../../contracts/probe-failure-conformance.json");

    fn at(value: &Value) -> Option<DateTime<Utc>> {
        value.as_str().map(|s| s.parse().expect("an RFC 3339 time"))
    }

    fn event(value: &Value) -> EventInfo {
        let text = |key: &str| value[key].as_str().map(str::to_string);
        EventInfo {
            name: "e".into(),
            namespace: "ns".into(),
            uid: "u".into(),
            type_: text("type").unwrap_or_default(),
            reason: text("reason"),
            message: text("message"),
            source: Some("kubelet".into()),
            involved_object: InvolvedObjectInfo {
                api_version: None,
                kind: "Pod".into(),
                name: "p".into(),
                namespace: Some("ns".into()),
                uid: None,
            },
            count: None,
            first_timestamp: at(&value["firstTimestamp"]),
            last_timestamp: at(&value["lastTimestamp"]),
        }
    }

    /// Fails when the window here and the one the page applies drift apart.
    #[test]
    fn the_window_is_the_one_the_shared_file_names() {
        let file: Value = serde_json::from_str(FILE).unwrap();
        assert_eq!(file["windowMinutes"].as_i64(), Some(PROBE_WINDOW_MINUTES));
    }

    /// Fails when a case in the shared corpus reads differently here than on the page.
    #[test]
    fn every_case_in_the_shared_corpus_gets_its_answer() {
        let file: Value = serde_json::from_str(FILE).unwrap();
        for case in file["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let containers: Vec<ContainerRestarts> =
                serde_json::from_value(case["containers"].clone()).unwrap();
            let events: Vec<EventInfo> = case["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(event)
                .collect();
            let now = at(&case["now"]).unwrap();
            let found = probe_failure(&containers, &events, now);
            assert_eq!(serde_json::to_value(&found).unwrap(), case["is"], "{name}");
        }
    }
}
