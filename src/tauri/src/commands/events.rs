//! Events commands

use crate::commands::helpers::ResourceContext;
use crate::error::Result;
use crate::resources::{
    ChainStop, EventInfo, NotServing, PodCause, PodStart, SetupWarning, SharedCause, Warned,
};
use crate::state::AppState;
use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::{Event, Pod};
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use tauri::State;

/// Server-side page size for the event walk. Big enough that the common
/// "latest 500" is one round trip when the namespace is quiet.
const EVENT_PAGE_SIZE: u32 = 500;

/// How many pages a request with a limit may walk.
///
/// The apiserver returns events in etcd key order, not newest first, and
/// has no sort — so the newest N can only be found by reading more than N
/// and sorting. Four pages covers the largest limit the UI offers and
/// bounds what a pathological cluster can cost a query the events page
/// re-reads every second.
const MAX_EVENT_PAGES: usize = 4;

/// Event filters
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EventFilters {
    pub namespace: Option<String>,
    pub involved_object_name: Option<String>,
    pub involved_object_kind: Option<String>,
    pub event_type: Option<String>, // "Normal" or "Warning"
    pub field_selector: Option<String>,
    pub limit: Option<i64>,
}

/// The newest events in scope, most recent first.
///
/// `limit` is that sentence — "latest 500" — and not a page size, which
/// is what it used to be passed as: one etcd-ordered page of 500,
/// *then* sorted newest-first, so the panel's "latest" was 500
/// arbitrary events with the newest of those on top. The type filter
/// was applied later still, in memory, so "Warnings · latest 500" spent
/// its whole budget on Normal events and came back with a handful of
/// rows. Both now happen where they belong: the type goes to the
/// apiserver as a field selector, and the limit is applied after the
/// sort.
///
/// `limit: None` means "everything", and walks until the collection is
/// exhausted — the same total the unbounded list it replaces returned,
/// in bounded pages instead of one response.
#[tauri::command]
pub async fn list_events(
    filters: Option<EventFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<EventInfo>> {
    crate::client::clock::timed(&state.perf, "listEvents", events_in(&state, filters)).await
}

async fn events_in(state: &AppState, filters: Option<EventFilters>) -> Result<Vec<EventInfo>> {
    let filters = filters.unwrap_or_default();
    let ctx = ResourceContext::for_list(state, filters.namespace)?;

    let mut field_selectors = Vec::new();
    if let Some(name) = &filters.involved_object_name {
        field_selectors.push(format!("involvedObject.name={name}"));
    }
    if let Some(kind) = &filters.involved_object_kind {
        field_selectors.push(format!("involvedObject.kind={kind}"));
    }
    if let Some(event_type) = &filters.event_type {
        field_selectors.push(format!("type={event_type}"));
    }
    if let Some(custom) = &filters.field_selector {
        field_selectors.push(custom.clone());
    }

    let mut base = ListParams::default().limit(EVENT_PAGE_SIZE);
    if !field_selectors.is_empty() {
        base = base.fields(&field_selectors.join(","));
    }

    // Use namespaced API when namespace is provided for proper filtering
    let api: kube::Api<Event> = ctx.namespaced_or_cluster_api();

    let budget = match filters.limit {
        Some(limit) if limit > 0 => MAX_EVENT_PAGES,
        _ => usize::MAX,
    };

    let mut items: Vec<Event> = Vec::new();
    let mut token: Option<String> = None;
    for page_number in 0..budget {
        let mut params = base.clone();
        if let Some(token) = token.as_deref() {
            params = params.continue_token(token);
        }
        let page = api.list(&params).await;
        let mut page = match (page, page_number) {
            (Ok(page), _) => page,
            // Nothing was read at all, so there is no answer to give.
            (Err(e), 0) => return Err(e.into()),
            // A continue token that expired mid-walk (a compaction, a
            // restarted apiserver) invalidates the rest of the walk, not
            // the pages already in hand.
            (Err(e), _) => {
                tracing::warn!("Event page {page_number} failed, returning what was read: {e}");
                break;
            }
        };
        token = page.metadata.continue_.take().filter(|t| !t.is_empty());
        items.append(&mut page.items);
        if token.is_none() {
            break;
        }
    }

    let mut events: Vec<EventInfo> = items.iter().map(EventInfo::from).collect();

    events.sort_by_key(|event| std::cmp::Reverse(event.last_timestamp));

    if let Some(limit) = filters.limit {
        if limit > 0 {
            events.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        }
    }

    Ok(events)
}

/// The most warnings one pod's read asks for: the kubelet repeats one by its count.
const POD_WARNINGS_PAGE: u32 = 100;

/// The kubelet's warnings about one pod, for a cause that names it: what a
/// pod the kubelet has not set up is waiting on.
#[tauri::command]
pub async fn get_pod_setup_warnings(
    namespace: String,
    uid: String,
    state: State<'_, AppState>,
) -> Result<Vec<SetupWarning>> {
    crate::validation::validate_namespace(&namespace)?;
    crate::validation::validate_dns_label(&uid)?;
    let ctx = ResourceContext::for_command(state.inner(), Some(namespace))?;
    let api: kube::Api<Event> = ctx.namespaced_api();
    crate::client::clock::timed(&state.perf, "getPodSetupWarnings", warnings_of(&api, &uid)).await
}

async fn warnings_of(api: &kube::Api<Event>, uid: &str) -> Result<Vec<SetupWarning>> {
    let params = ListParams::default()
        .fields(&format!("involvedObject.uid={uid},type=Warning"))
        .limit(POD_WARNINGS_PAGE);
    let events = api.list(&params).await?;
    Ok(crate::resources::setup_warnings(uid, &events.items))
}

/// The pods the kubelet is setting up inside their wait that it has already
/// warned about: its warning, not the clock, says they are not coming. One
/// read per such pod; a read that fails leaves its pod to the clock.
pub(crate) async fn warned_while_creating<'a>(
    api: &kube::Api<Event>,
    pods: impl IntoIterator<Item = &'a Pod>,
    now: DateTime<Utc>,
) -> HashSet<&'a str> {
    let reads = pods
        .into_iter()
        .filter(|pod| creating_in_wait(pod, now))
        .filter_map(|pod| {
            let uid = pod.metadata.uid.as_deref()?;
            Some(async move {
                warnings_of(api, uid)
                    .await
                    .is_ok_and(|warnings| !warnings.is_empty())
                    .then_some(uid)
            })
        });
    futures::future::join_all(reads)
        .await
        .into_iter()
        .flatten()
        .collect()
}

fn creating_in_wait(pod: &Pod, now: DateTime<Utc>) -> bool {
    matches!(crate::resources::pod_start(pod), PodStart::Starting { until } if until > now)
        && matches!(
            crate::resources::pod_cause(pod),
            Some(PodCause::Creating { .. })
        )
}

/// The pod a stop's cause names, where the kubelet has not set it up and
/// nobody has read its warnings yet.
fn unwarned(stop: &ChainStop) -> Option<&str> {
    match stop {
        ChainStop::NoneReady {
            cause:
                Some(SharedCause {
                    cause:
                        PodCause::Creating {
                            uid,
                            kubelet: Warned::NotRead,
                            ..
                        },
                    ..
                }),
            ..
        } => Some(uid),
        _ => None,
    }
}

/// Each stop that names a pod the kubelet has not set up, with the warnings
/// it wrote about that pod in `namespace`: the chain, the Service rows and
/// the workload's own line then quote the same words. One read per pod.
pub(crate) async fn with_kubelet_words<'a>(
    client: &kube::Client,
    stops: impl IntoIterator<Item = (&'a str, &'a mut ChainStop)>,
) {
    let stops: Vec<_> = stops.into_iter().collect();
    let wanted: BTreeSet<(String, String)> = stops
        .iter()
        .filter_map(|(ns, stop)| unwarned(stop).map(|uid| ((*ns).to_string(), uid.to_string())))
        .collect();
    if wanted.is_empty() {
        return;
    }
    let reads = wanted.into_iter().map(|(ns, uid)| async move {
        let api: kube::Api<Event> = kube::Api::namespaced(client.clone(), &ns);
        let warned = match warnings_of(&api, &uid).await {
            Ok(warnings) => Warned::Read { warnings },
            Err(error) if error.is_refusal() => Warned::Refused,
            Err(error) => Warned::Failed {
                said: error.to_string(),
            },
        };
        ((ns, uid), warned)
    });
    let read: HashMap<(String, String), Warned> =
        futures::future::join_all(reads).await.into_iter().collect();
    fill_warned(stops, &read);
}

/// Each unwarned stop with the warnings read for its pod, where they were.
fn fill_warned(stops: Vec<(&str, &mut ChainStop)>, read: &HashMap<(String, String), Warned>) {
    for (ns, stop) in stops {
        let Some(uid) = unwarned(stop).map(str::to_string) else {
            continue;
        };
        let Some(warned) = read.get(&(ns.to_string(), uid)) else {
            continue;
        };
        if let ChainStop::NoneReady {
            cause: Some(shared),
            why,
            ..
        } = stop
        {
            shared.cause = shared.cause.clone().warned(warned.clone());
            let faulted = matches!(warned, Warned::Read { warnings } if !warnings.is_empty());
            if faulted && *why == NotServing::ComingUp {
                *why = if shared.pods == shared.of {
                    NotServing::Starting
                } else {
                    NotServing::Mixed
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::{Existence, ObjectRef, SetupFault};

    /// A page reads the kubelet's warnings only for the pods it is setting up
    /// inside their wait. Fails if such a pod goes unread, or one the
    /// scheduler has not placed, or one past its wait, costs a read.
    #[test]
    fn only_a_pod_the_kubelet_is_setting_up_inside_its_wait_is_read_for_warnings() {
        let now = Utc::now();
        let ago = |seconds: i64| (now - chrono::Duration::seconds(seconds)).to_rfc3339();
        let pending = |scheduled: &str, seconds: i64| -> Pod {
            serde_json::from_value(serde_json::json!({
                "metadata": {"name": "web-1", "uid": "u1", "creationTimestamp": ago(seconds)},
                "status": {
                    "phase": "Pending",
                    "conditions": [{"type": "PodScheduled", "status": scheduled,
                        "lastTransitionTime": ago(seconds)}],
                    "containerStatuses": [{"name": "web", "image": "", "imageID": "",
                        "ready": false, "restartCount": 0,
                        "state": {"waiting": {"reason": "ContainerCreating"}}}]
                }
            }))
            .expect("a pod this test wrote itself")
        };
        assert!(creating_in_wait(&pending("True", 5), now));
        assert!(!creating_in_wait(&pending("False", 5), now));
        assert!(!creating_in_wait(&pending("True", 3600), now));
    }

    fn none_ready(cause: PodCause, why: NotServing) -> ChainStop {
        ChainStop::NoneReady {
            service: ObjectRef::new(
                "Service",
                "web",
                Some("shop".to_string()),
                Existence::Present,
            ),
            selector: "app=web".to_string(),
            pods: 2,
            why,
            cause: Some(SharedCause {
                cause,
                pods: 2,
                of: 2,
            }),
        }
    }

    fn creating(uid: &str) -> PodCause {
        PodCause::Creating {
            uid: uid.to_string(),
            since: None,
            sandbox: Some(false),
            kubelet: Warned::NotRead,
        }
    }

    fn kubelet_of(stop: &ChainStop) -> Option<&Warned> {
        match stop {
            ChainStop::NoneReady {
                cause:
                    Some(SharedCause {
                        cause: PodCause::Creating { kubelet, .. },
                        ..
                    }),
                ..
            } => Some(kubelet),
            _ => None,
        }
    }

    /// The Service's chain said "what it waits on is in the kubelet's
    /// warnings" under a headline that quoted them. Fails if a stop naming a
    /// pod the kubelet has not set up keeps `NotRead` after its read, or one
    /// takes another pod's warnings.
    #[test]
    fn a_stop_naming_a_pod_being_set_up_carries_the_warnings_read_for_it() {
        let warning = SetupWarning {
            reason: "FailedMount".to_string(),
            said: "secret \"web-creds\" not found".to_string(),
            count: 3,
            at: None,
            fault: SetupFault::Missing {
                volume: Some("creds".to_string()),
                kind: "Secret".to_string(),
                name: "web-creds".to_string(),
            },
        };
        let read = HashMap::from([(
            ("shop".to_string(), "u1".to_string()),
            Warned::Read {
                warnings: vec![warning.clone()],
            },
        )]);
        let mut named = none_ready(creating("u1"), NotServing::Starting);
        let mut unread = none_ready(creating("u2"), NotServing::Starting);
        fill_warned(vec![("shop", &mut named), ("shop", &mut unread)], &read);
        assert_eq!(
            kubelet_of(&named),
            Some(&Warned::Read {
                warnings: vec![warning]
            })
        );
        assert_eq!(kubelet_of(&unread), Some(&Warned::NotRead));
        assert_eq!(unwarned(&named), None);
        assert_eq!(unwarned(&unread), Some("u2"));
    }

    fn why_of(stop: &ChainStop) -> Option<NotServing> {
        match stop {
            ChainStop::NoneReady { why, .. } => Some(*why),
            _ => None,
        }
    }

    /// no-config's Service said its pods were coming up, in blue, above the
    /// kubelet's `FailedMount` it quoted. Fails if a stop whose pods the
    /// kubelet warned about stays coming up, or one read with no warning
    /// stops being so.
    #[test]
    fn a_stop_whose_pods_the_kubelet_warned_about_is_not_coming_up() {
        let read = |warnings: Vec<SetupWarning>| {
            HashMap::from([(
                ("shop".to_string(), "u1".to_string()),
                Warned::Read { warnings },
            )])
        };
        let warning = SetupWarning {
            reason: "FailedMount".to_string(),
            said: "secret \"web-creds\" not found".to_string(),
            count: 1,
            at: None,
            fault: SetupFault::Other,
        };
        let mut warned = none_ready(creating("u1"), NotServing::ComingUp);
        fill_warned(vec![("shop", &mut warned)], &read(vec![warning]));
        assert_eq!(why_of(&warned), Some(NotServing::Starting));
        let mut quiet = none_ready(creating("u1"), NotServing::ComingUp);
        fill_warned(vec![("shop", &mut quiet)], &read(Vec::new()));
        assert_eq!(why_of(&quiet), Some(NotServing::ComingUp));
    }
}
