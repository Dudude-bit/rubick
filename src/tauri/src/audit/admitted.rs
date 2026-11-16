//! Which namespaces' pods pass a webhook that may change them on the way in
//! (reference/access-authn-authz/extensible-admission-controllers). Audit
//! judges a workload's template; a mutating webhook may add containers the
//! template does not show, as Istio's and Linkerd's injectors add their
//! init containers, and the Pod Security controls never see them.

use std::collections::BTreeMap;

use k8s_openapi::api::admissionregistration::v1::{MutatingWebhook, MutatingWebhookConfiguration};
use k8s_openapi::api::core::v1::Namespace;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use kube::api::{Api, ListParams};
use kube::Client;

use super::Why;
use crate::resources::Selector;

/// The pod webhooks and the namespaces' labels, as last read for a scope.
#[derive(Debug, Clone)]
pub struct Admission {
    pub read_for: Option<Vec<String>>,
    /// Each webhook on pod creation, by name, with its namespace selector;
    /// or why the webhooks could not be read.
    webhooks: Result<Vec<(String, LabelSelector)>, Why>,
    /// Each namespace's labels that could be read.
    labels: BTreeMap<String, BTreeMap<String, String>>,
}

impl Admission {
    /// The webhooks that may change `namespace`'s pods, or why that is not
    /// known; `None` where the read did not ask about it.
    #[must_use]
    pub fn over(&self, namespace: &str) -> Option<Result<Vec<String>, Why>> {
        if self
            .read_for
            .as_ref()
            .is_some_and(|read| !read.iter().any(|name| name == namespace))
        {
            return None;
        }
        Some(match &self.webhooks {
            Ok(webhooks) => Ok(admitting(webhooks, self.labels.get(namespace))),
            Err(why) => Err(why.clone()),
        })
    }

    #[cfg(test)]
    pub(super) fn of(
        webhooks: Vec<(String, LabelSelector)>,
        labels: BTreeMap<String, BTreeMap<String, String>>,
    ) -> Self {
        Self {
            read_for: None,
            webhooks: Ok(webhooks),
            labels,
        }
    }
}

/// Whether one of a webhook's rules takes in a pod being created.
fn takes_in_pods(webhook: &MutatingWebhook) -> bool {
    let has = |list: Option<&Vec<String>>, wanted: &[&str]| {
        list.is_some_and(|list| list.iter().any(|v| wanted.contains(&v.as_str())))
    };
    webhook.rules.iter().flatten().any(|rule| {
        has(rule.operations.as_ref(), &["CREATE", "*"])
            && has(rule.api_groups.as_ref(), &["", "*"])
            && has(rule.resources.as_ref(), &["pods", "*", "*/*"])
    })
}

/// The pod webhooks whose namespace selector takes in a namespace with
/// `labels`, by name. Labels that could not be read take in every webhook
/// that selects at all: nobody looked.
fn admitting(
    webhooks: &[(String, LabelSelector)],
    labels: Option<&BTreeMap<String, String>>,
) -> Vec<String> {
    webhooks
        .iter()
        .filter(|(_, selector)| match labels {
            Some(labels) => Selector::Query(Some(selector)).matches(labels) != Some(false),
            None => true,
        })
        .map(|(name, _)| name.clone())
        .collect()
}

/// Reads the pod webhooks, and the labels of the scope's namespaces: all
/// of them listed, or one at a time where the scope is a selection, as a
/// reader bound to namespaces may get its own and not list the rest.
pub async fn read(client: &Client, scope: Option<&[String]>) -> Admission {
    let read_for = scope.map(<[String]>::to_vec);
    let configs = Api::<MutatingWebhookConfiguration>::all(client.clone())
        .list(&ListParams::default())
        .await;
    let webhooks = match configs {
        Ok(list) => Ok(list
            .items
            .iter()
            .flat_map(|config| config.webhooks.iter().flatten())
            .filter(|webhook| takes_in_pods(webhook))
            .map(|webhook| {
                (
                    webhook.name.clone(),
                    webhook.namespace_selector.clone().unwrap_or_default(),
                )
            })
            .collect()),
        Err(error) => Err(super::why_of(&error.into())),
    };
    let namespaces = Api::<Namespace>::all(client.clone());
    let labelled =
        |meta: kube::api::ObjectMeta| Some((meta.name?, meta.labels.unwrap_or_default()));
    let labels = match scope {
        None => namespaces
            .list_metadata(&ListParams::default())
            .await
            .map(|list| {
                list.items
                    .into_iter()
                    .filter_map(|ns| labelled(ns.metadata))
                    .collect()
            })
            .unwrap_or_default(),
        Some(names) => {
            futures::future::join_all(names.iter().map(|name| namespaces.get_metadata(name)))
                .await
                .into_iter()
                .filter_map(|got| labelled(got.ok()?.metadata))
                .collect()
        }
    };
    Admission {
        read_for,
        webhooks,
        labels,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn webhook(value: serde_json::Value) -> MutatingWebhook {
        serde_json::from_value(value).expect("a webhook")
    }

    /// A webhook that takes in pod creation may change a pod; one for
    /// ConfigMaps, or for pod deletion only, may not. Fails if Istio's
    /// injector is missed, or every webhook counted.
    #[test]
    fn only_a_webhook_on_pod_creation_may_change_a_pod() {
        let rule = |operations: &[&str], groups: &[&str], resources: &[&str]| {
            webhook(
                json!({ "name": "w", "admissionReviewVersions": ["v1"], "sideEffects": "None",
                "clientConfig": {}, "rules": [{ "operations": operations, "apiGroups": groups,
                "apiVersions": ["v1"], "resources": resources }] }),
            )
        };
        assert!(takes_in_pods(&rule(&["CREATE"], &[""], &["pods"])));
        assert!(takes_in_pods(&rule(&["*"], &["*"], &["*"])));
        assert!(!takes_in_pods(&rule(&["CREATE"], &[""], &["configmaps"])));
        assert!(!takes_in_pods(&rule(&["DELETE"], &[""], &["pods"])));
    }

    /// A webhook selects namespaces by their labels; with none, every one.
    /// Fails if Istio's injector is said to touch a namespace not labelled
    /// for it, or one whose labels nobody read is called untouched.
    #[test]
    fn a_namespace_is_admitted_through_the_webhooks_its_labels_select() {
        let injection: LabelSelector =
            serde_json::from_value(json!({ "matchLabels": { "istio-injection": "enabled" } }))
                .expect("a selector");
        let webhooks = vec![
            ("sidecar-injector.istio.io".to_string(), injection),
            (
                "everywhere.example.com".to_string(),
                LabelSelector::default(),
            ),
        ];
        let labelled: BTreeMap<String, String> =
            [("istio-injection".to_string(), "enabled".to_string())].into();
        assert_eq!(
            admitting(&webhooks, Some(&labelled)),
            vec!["sidecar-injector.istio.io", "everywhere.example.com"]
        );
        assert_eq!(
            admitting(&webhooks, Some(&BTreeMap::new())),
            vec!["everywhere.example.com"]
        );
        assert_eq!(admitting(&webhooks, None).len(), 2);
    }
}
