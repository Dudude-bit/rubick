//! One object's findings for its own page and peek, from the same
//! functions the Audit page reads. Never starts the index: where it is
//! running and reads the object's namespace, its answer is the page's;
//! otherwise one read of the object and the five kinds its rules need,
//! the five kept a little while per namespace, and the discovery of the
//! groups its deprecated versions were in.

use std::sync::Arc;
use std::time::Duration;

use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{LimitRange, Pod, Service, ServiceAccount};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::api::{Api, DynamicObject, ListParams};
use kube::Client;

use super::answer::{object_in, world, ObjectAudit};
use super::context::{beside, Beside, Defaults, Replicated, Scales};
use super::index::{audited, entry_of, key_of, pod_judged, why_unread, Body};
use super::{Subject, Why};
use crate::error::{Error, Result};
use crate::state::AppState;

/// How long a namespace's neighbours, read for a detail page, are kept.
const KEPT_FOR: Duration = Duration::from_secs(30);

/// A namespace's Services, budgets, autoscalers, `LimitRanges` and default
/// `ServiceAccount`, read at once: five calls.
async fn read_beside(client: &Client, namespace: &str) -> Beside {
    let params = ListParams::default();
    let services: Api<Service> = Api::namespaced(client.clone(), namespace);
    let budgets: Api<PodDisruptionBudget> = Api::namespaced(client.clone(), namespace);
    let autoscalers: Api<HorizontalPodAutoscaler> = Api::namespaced(client.clone(), namespace);
    let limits: Api<LimitRange> = Api::namespaced(client.clone(), namespace);
    let accounts: Api<ServiceAccount> = Api::namespaced(client.clone(), namespace);
    let (services, budgets, autoscalers, limits, account) = tokio::join!(
        services.list(&params),
        budgets.list(&params),
        autoscalers.list(&params),
        limits.list(&params),
        accounts.get_opt("default"),
    );
    let read = |error: kube::Error| super::why_of(&Error::from(error));
    Beside {
        namespace: namespace.to_string(),
        services: services.map_err(read).map(|list| {
            list.items
                .into_iter()
                .map(|service| {
                    let name = service.metadata.name.unwrap_or_default();
                    (
                        name,
                        service.spec.and_then(|s| s.selector).unwrap_or_default(),
                    )
                })
                .collect()
        }),
        budgets: budgets.map_err(read).map(|list| {
            list.items
                .into_iter()
                .map(|pdb| pdb.spec.and_then(|s| s.selector))
                .collect()
        }),
        autoscalers: autoscalers.map_err(read).map(|list| {
            list.items
                .into_iter()
                .filter_map(|hpa| {
                    let spec = hpa.spec?;
                    Some(Scales {
                        name: hpa.metadata.name.unwrap_or_default(),
                        kind: spec.scale_target_ref.kind,
                        target: spec.scale_target_ref.name,
                        min: spec.min_replicas.unwrap_or(1),
                    })
                })
                .collect()
        }),
        limits: limits.map_err(read).map(|list| Defaults::of(&list.items)),
        account: account
            .map_err(read)
            .map(|account| account.and_then(|a| a.automount_service_account_token)),
    }
}

async fn beside_in(
    state: &AppState,
    context: &str,
    client: &Client,
    namespace: &str,
) -> Arc<Beside> {
    let key = (context.to_string(), namespace.to_string());
    if let Some(kept) = state.audit.besides.get(&key) {
        if kept.0.elapsed() < KEPT_FOR {
            return kept.1.clone();
        }
    }
    let era = state.audit.era(context);
    let read = Arc::new(read_beside(client, namespace).await);
    state.audit.keep_beside(era, key, read.clone());
    read
}

fn controller_of(
    meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta,
) -> Option<(String, String)> {
    meta.owner_references
        .iter()
        .flatten()
        .find(|owner| owner.controller == Some(true))
        .map(|owner| (owner.kind.clone(), owner.name.clone()))
}

fn elsewhere(subject: Subject, on: Subject) -> ObjectAudit {
    ObjectAudit {
        system: super::is_system(&subject, None),
        subject,
        findings: Vec::new(),
        unchecked: Vec::new(),
        judged_on: Some(on),
    }
}

/// Refuses a name that would leave its place in an API path. A deprecated
/// API the server was asked for is named `group/version resource` and is
/// only ever looked up in the page's own answer, never asked of the API.
fn checked_name(kind: &str, namespace: Option<&str>, name: &str) -> Result<()> {
    if let Some(namespace) = namespace {
        crate::validation::validate_namespace(namespace)?;
    }
    match kind {
        "Namespace" => crate::validation::validate_namespace(name),
        super::DEPRECATED_API if namespace.is_none() && !name.is_empty() => Ok(()),
        // A role's name may hold a colon, which no DNS name does.
        _ => crate::validation::validate_path_segment(name),
    }
}

/// One object's findings, for its page and its peek, or for a row the
/// Audit page opens. `namespace` is `None` for a cluster-scoped object and
/// for a namespace's own findings.
pub async fn object_audit(
    state: &AppState,
    kind: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<ObjectAudit> {
    checked_name(kind, namespace, name)?;
    let here = state.here()?;
    let minor = super::minor_of(state, &here.context);
    let subject = Subject {
        kind: kind.to_string(),
        namespace: namespace.map(str::to_string),
        name: name.to_string(),
    };

    let resource = audited()
        .into_iter()
        .map(|(resource, _)| resource)
        .find(|resource| resource.kind == kind);
    if let Some(index) = state.audit.running(&here.context) {
        let read = resource.as_ref().is_none_or(|resource| {
            why_unread(&index.slot_states(), &key_of(resource), namespace).is_none()
        });
        if read {
            let owners = state.ownership.running(&here.context);
            let missing = Why::Reading;
            let owners = owners.as_deref().ok_or(&missing);
            let scope = namespace.map(|namespace| [namespace.to_string()]);
            let seen = world(&index, owners, scope.as_ref().map(<[String; 1]>::as_slice));
            if let Some(found) = object_in(&seen, &subject) {
                return Ok(found);
            }
        }
    }
    let Some(namespace) = namespace else {
        return Err(Error::InvalidInput(format!(
            "{kind} {name} is judged only while the Audit page is open"
        )));
    };

    let client = (*here.client).clone();
    let (own, facts, replicas, system, fields) = if kind == "Pod" {
        let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
        let pod = pods.get(name).await?;
        match controller_of(&pod.metadata) {
            Some((owner, _)) if owner == "ReplicaSet" => {
                if let Some(deployment) = crate::resources::deployment_of(&pod) {
                    let on = Subject {
                        kind: "Deployment".to_string(),
                        namespace: subject.namespace.clone(),
                        name: deployment.to_string(),
                    };
                    return Ok(elsewhere(subject, on));
                }
            }
            Some((owner, owner_name)) if owner == "StatefulSet" || owner == "DaemonSet" => {
                let on = Subject {
                    kind: owner,
                    namespace: subject.namespace.clone(),
                    name: owner_name,
                };
                return Ok(elsewhere(subject, on));
            }
            Some((owner, owner_name)) if owner == "Job" => {
                let jobs: Api<Job> = Api::namespaced(client.clone(), namespace);
                let job = jobs.get(&owner_name).await?;
                let on = match controller_of(&job.metadata) {
                    Some((cron, cron_name)) if cron == "CronJob" => Subject {
                        kind: cron,
                        namespace: subject.namespace.clone(),
                        name: cron_name,
                    },
                    _ => Subject {
                        kind: owner,
                        namespace: subject.namespace.clone(),
                        name: owner_name,
                    },
                };
                return Ok(elsewhere(subject, on));
            }
            _ => {}
        }
        let Some(judged) = pod_judged(&pod, minor) else {
            return Err(Error::InvalidInput(format!("pod {name} has no spec")));
        };
        (
            judged.own,
            judged.facts,
            Replicated(None),
            super::is_system(&subject, None),
            pod.metadata.managed_fields.unwrap_or_default(),
        )
    } else {
        let Some(resource) = resource else {
            return Err(Error::InvalidInput(format!("Audit does not judge {kind}")));
        };
        let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &resource);
        let object = api.get(name).await?;
        if kind == "Job" {
            if let Some((cron, cron_name)) =
                controller_of(&object.metadata).filter(|(k, _)| k == "CronJob")
            {
                let on = Subject {
                    kind: cron,
                    namespace: subject.namespace.clone(),
                    name: cron_name,
                };
                return Ok(elsewhere(subject, on));
            }
        }
        let fields = object.metadata.managed_fields.clone().unwrap_or_default();
        let Some(entry) = entry_of(kind, object, minor) else {
            return Err(Error::InvalidInput(format!(
                "{kind} {name} could not be read"
            )));
        };
        let Body::Workload { facts, replicas } = entry.body else {
            return Err(Error::InvalidInput(format!("{kind} has no pod template")));
        };
        (entry.own, facts, replicas, entry.system, fields)
    };
    let ns = beside_in(state, &here.context, &client, namespace).await;
    let (mut findings, mut unchecked) = beside(kind, name, &facts, replicas, &ns);
    findings.extend(own);
    let (written, blind) = super::upgrade::written_of(&here, minor, &subject, &fields).await;
    findings.extend(written);
    unchecked.extend(blind);
    findings.sort_by_key(|f| (f.severity, f.rule));
    unchecked.sort_by_key(|u| u.rule);
    Ok(ObjectAudit {
        subject,
        system,
        findings,
        unchecked,
        judged_on: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row for a deprecated API the server was asked for opens, though its
    /// name holds a slash; any other kind's name with one is still refused
    /// before it reaches a path. Would break if opening that row said the
    /// name could not be an object's, or the exception reached a real kind.
    #[test]
    fn a_requested_api_opens_by_its_name_and_no_real_kind_takes_a_slash() {
        let api = "extensions/v1beta1 ingresses";
        assert!(checked_name(super::super::DEPRECATED_API, None, api).is_ok());
        assert!(checked_name("Deployment", Some("shop"), "web/../x").is_err());
        assert!(checked_name("ClusterRole", None, api).is_err());
        assert!(checked_name(super::super::DEPRECATED_API, Some("shop"), api).is_err());
    }
}
