//! What a pod needs to run: the `ConfigMaps`, Secrets, claims and identity its
//! spec names.

use super::*;
use k8s_openapi::api::core::v1::ServiceAccount;

/// The `ConfigMaps`, Secrets, claims and identity a pod spec names, with how
/// each one is used.
pub(super) fn uses_from_spec(
    ns: &str,
    subject: &ObjectRef,
    spec: &PodSpec,
    claims: &Read<PersistentVolumeClaim>,
    out: &mut Neighbourhood,
) {
    let mut targets: Vec<(String, String)> = Vec::new();
    for volume in spec.volumes.iter().flatten() {
        for object in crate::resources::volume_source(volume).1 {
            targets.push((object.kind, object.name));
        }
    }
    for container in spec
        .init_containers
        .iter()
        .flatten()
        .chain(&spec.containers)
    {
        for env in container.env.iter().flatten() {
            let Some(from) = &env.value_from else {
                continue;
            };
            if let Some(r) = &from.config_map_key_ref {
                targets.push(("ConfigMap".to_string(), r.name.clone()));
            }
            if let Some(r) = &from.secret_key_ref {
                targets.push(("Secret".to_string(), r.name.clone()));
            }
        }
        for env_from in container.env_from.iter().flatten() {
            if let Some(r) = &env_from.config_map_ref {
                targets.push(("ConfigMap".to_string(), r.name.clone()));
            }
            if let Some(r) = &env_from.secret_ref {
                targets.push(("Secret".to_string(), r.name.clone()));
            }
        }
    }
    for pull in spec.image_pull_secrets.iter().flatten() {
        targets.push(("Secret".to_string(), pull.name.clone()));
    }
    if let Some(account) = &spec.service_account_name {
        targets.push(("ServiceAccount".to_string(), account.clone()));
    }

    let mut seen = HashSet::new();
    for (kind, name) in targets {
        if !seen.insert((kind.clone(), name.clone())) {
            continue;
        }
        let usages = usages_in_pod_spec(spec, &kind, &name);
        if usages.is_empty() {
            continue;
        }
        out.edge(
            subject.clone(),
            named_object(ns, &kind, &name, claims),
            Relation::Uses { usages },
        );
    }
}

/// Asks for each `ConfigMap`, Secret and `ServiceAccount` the spec named, by
/// name and for its metadata alone. A reader who may get them sees present or
/// missing; a refusal leaves the row `notChecked`, never missing, and an
/// expired session ends the call as every other read here does. One whose key
/// a variable reads is read whole, so the key is checked as the Containers tab
/// checks it.
pub(super) async fn check_named(ctx: &ResourceContext, out: &mut Neighbourhood) -> Result<()> {
    let at: Vec<usize> = out
        .edges
        .iter()
        .enumerate()
        .filter(|(_, edge)| {
            matches!(edge.relation, Relation::Uses { .. })
                && edge.to.existence == Existence::NotChecked
        })
        .map(|(at, _)| at)
        .collect();
    let answers = futures::future::join_all(at.iter().map(|&i| {
        let edge = &out.edges[i];
        look_up(
            ctx,
            &edge.to.kind,
            &edge.to.name,
            reads_a_key(&edge.relation),
        )
    }))
    .await;
    for (i, answer) in at.into_iter().zip(answers) {
        let (existence, keys) = answer?;
        let to = out.edges[i].to.clone();
        out.edges[i].to.existence = existence;
        if keys.is_some() {
            mark_keys(std::slice::from_mut(&mut out.edges[i]), &to, keys.as_ref());
        }
    }
    Ok(())
}

fn reads_a_key(relation: &Relation) -> bool {
    matches!(relation, Relation::Uses { usages } if usages.iter().any(|use_| matches!(use_, Usage::Env { .. })))
}

async fn look_up(
    ctx: &ResourceContext,
    kind: &str,
    name: &str,
    keyed: bool,
) -> Result<(Existence, Option<BTreeSet<String>>)> {
    let found = match kind {
        "ConfigMap" | "Secret" if keyed => read_keys(ctx, kind, name)
            .await
            .map(|keys| (keys.is_some(), keys)),
        "ConfigMap" => is_there(ctx.namespaced_api::<ConfigMap>(), name)
            .await
            .map(|f| (f, None)),
        "Secret" => is_there(ctx.namespaced_api::<Secret>(), name)
            .await
            .map(|f| (f, None)),
        "ServiceAccount" => is_there(ctx.namespaced_api::<ServiceAccount>(), name)
            .await
            .map(|f| (f, None)),
        _ => return Ok((Existence::NotChecked, None)),
    };
    match found {
        Ok((true, keys)) => Ok((Existence::Present, keys)),
        Ok((false, _)) => Ok((Existence::Missing, None)),
        Err(err) => match Error::from(err) {
            expired @ Error::CredentialsExpired(_) => Err(expired),
            _ => Ok((Existence::NotChecked, None)),
        },
    }
}

async fn is_there<K>(api: Api<K>, name: &str) -> kube::Result<bool>
where
    K: kube::Resource + Clone + serde::de::DeserializeOwned + std::fmt::Debug,
{
    api.get_metadata_opt(name)
        .await
        .map(|found| found.is_some())
}

/// A name a pod spec states, resolved as far as this call actually looked.
///
/// Claims that were listed carry their phase and size and can be called
/// present or missing. `ConfigMaps`, Secrets and `ServiceAccounts` are not
/// listed here; `check_named` looks each one up afterwards, and until it has,
/// `notChecked` is the difference between "the app did not ask" and "the
/// cluster does not have it".
///
/// A claim list the cluster **refused** belongs with the second group, not
/// the first. Reading `Err` as "no claims came back" is how a 403 became
/// "this volume does not exist", in red, on a pod whose volume is mounted
/// and healthy.
pub(super) fn named_object(
    ns: &str,
    kind: &str,
    name: &str,
    claims: &Read<PersistentVolumeClaim>,
) -> ObjectRef {
    if kind != "PersistentVolumeClaim" {
        return ObjectRef::unchecked(kind, name, Some(ns.to_string()));
    }
    let Ok(claims) = claims else {
        return ObjectRef::unchecked(kind, name, Some(ns.to_string()));
    };
    match claims.iter().find(|claim| claim.name_any() == name) {
        Some(claim) => claim_ref(claim, ns),
        None => ObjectRef::new(kind, name, Some(ns.to_string()), Existence::Missing),
    }
}

pub(super) fn claim_ref(claim: &PersistentVolumeClaim, ns: &str) -> ObjectRef {
    let info = crate::resources::PersistentVolumeClaimInfo::from(claim);
    ObjectRef::new(
        "PersistentVolumeClaim",
        &claim.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Claim {
        phase: info.status,
        capacity: info.capacity,
        storage_class: info.storage_class,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::{failure, server};

    const NS: &str = "team-checkout";

    /// checkout-api's pod spec as the cluster stores it: the token volume's
    /// projected kube-root-ca.crt, `envFrom` checkout-config, the default
    /// identity, a password from Secret checkout-db and a flag from a
    /// `ConfigMap` that is not there.
    fn checkout_api_spec() -> serde_json::Value {
        serde_json::json!({
            "serviceAccountName": "default",
            "containers": [{
                "name": "api",
                "image": "ghcr.io/acme/checkout-api:1.4.2",
                "envFrom": [{ "configMapRef": { "name": "checkout-config" } }],
                "env": [
                    {
                        "name": "DB_PASSWORD",
                        "valueFrom": { "secretKeyRef": { "name": "checkout-db", "key": "password" } }
                    },
                    {
                        "name": "FLAGS",
                        "valueFrom": { "configMapKeyRef": { "name": "feature-flags", "key": "all" } }
                    }
                ],
                "volumeMounts": [{
                    "name": "kube-api-access",
                    "mountPath": "/var/run/secrets/kubernetes.io/serviceaccount",
                    "readOnly": true
                }]
            }],
            "volumes": [{
                "name": "kube-api-access",
                "projected": { "sources": [
                    { "serviceAccountToken": { "path": "token" } },
                    { "configMap": { "name": "kube-root-ca.crt", "items": [{ "key": "ca.crt", "path": "ca.crt" }] } }
                ] }
            }]
        })
    }

    fn metadata(name: &str) -> (u16, String) {
        let body = serde_json::json!({
            "apiVersion": "meta.k8s.io/v1",
            "kind": "PartialObjectMetadata",
            "metadata": { "name": name, "namespace": NS },
        });
        (200, body.to_string())
    }

    /// What Marco's Role answers for each name the spec states: get on
    /// `ConfigMaps` and `ServiceAccounts`, nothing on Secrets.
    fn marco(subject: (&'static str, u16, String)) -> Vec<(&'static str, u16, String)> {
        let named = |path, (status, body): (u16, String)| (path, status, body);
        vec![
            subject,
            named(
                "/api/v1/namespaces/team-checkout/configmaps/kube-root-ca.crt",
                metadata("kube-root-ca.crt"),
            ),
            named(
                "/api/v1/namespaces/team-checkout/configmaps/checkout-config",
                metadata("checkout-config"),
            ),
            named(
                "/api/v1/namespaces/team-checkout/configmaps/feature-flags",
                failure(404, "NotFound"),
            ),
            named(
                "/api/v1/namespaces/team-checkout/serviceaccounts/default",
                metadata("default"),
            ),
            named(
                "/api/v1/namespaces/team-checkout/secrets/checkout-db",
                failure(403, "Forbidden"),
            ),
        ]
    }

    fn pod_list() -> (&'static str, u16, String) {
        let pod = serde_json::json!({
            "metadata": { "name": "checkout-api-6767fbfdb7-blpfk", "namespace": NS },
            "spec": checkout_api_spec(),
        });
        let list = serde_json::json!({ "apiVersion": "v1", "kind": "List", "metadata": {}, "items": [pod] });
        (
            "/api/v1/namespaces/team-checkout/pods",
            200,
            list.to_string(),
        )
    }

    fn deployment() -> (&'static str, u16, String) {
        let deployment = serde_json::json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "checkout-api", "namespace": NS },
            "spec": {
                "selector": { "matchLabels": { "app": "checkout-api" } },
                "template": {
                    "metadata": { "labels": { "app": "checkout-api" } },
                    "spec": checkout_api_spec(),
                },
            },
        });
        (
            "/apis/apps/v1/namespaces/team-checkout/deployments/checkout-api",
            200,
            deployment.to_string(),
        )
    }

    async fn page(
        routes: Vec<(&'static str, u16, String)>,
        kind: &str,
        name: &str,
    ) -> Result<ResourceConnections> {
        let (client, _) = server(routes).await;
        let ctx = ResourceContext::from_client(client, NS.to_string());
        connections_of(&ctx, kind, name, None).await
    }

    fn existence(page: &ResourceConnections, kind: &str, name: &str) -> Existence {
        page.edges
            .iter()
            .find(|edge| edge.to.kind == kind && edge.to.name == name)
            .unwrap_or_else(|| panic!("no edge to {kind} {name}"))
            .to
            .existence
    }

    fn assert_marco_sees(page: &ResourceConnections) {
        for (kind, name) in [
            ("ConfigMap", "kube-root-ca.crt"),
            ("ConfigMap", "checkout-config"),
            ("ServiceAccount", "default"),
        ] {
            assert_eq!(
                existence(page, kind, name),
                Existence::Present,
                "{kind} {name}"
            );
        }
        assert_eq!(
            existence(page, "ConfigMap", "feature-flags"),
            Existence::Missing
        );
        assert_eq!(
            existence(page, "Secret", "checkout-db"),
            Existence::NotChecked,
            "a refused lookup is not a missing Secret"
        );
    }

    /// Marco's pod Connections said "not checked" beside kube-root-ca.crt,
    /// checkout-config and the default `ServiceAccount`, all of which his
    /// Role may get. Fails if a name the cluster answered for stays
    /// unchecked, if a 404 is not missing, or if a 403 is called missing.
    #[tokio::test]
    async fn a_pod_s_named_objects_are_looked_up_and_only_a_refusal_stays_unchecked() {
        let page = page(marco(pod_list()), "Pod", "checkout-api-6767fbfdb7-blpfk")
            .await
            .expect("a page");
        assert_marco_sees(&page);
    }

    /// The Deployment's Connections draw the same template, so they read the
    /// same answers; fails if only the pod's page looks the names up.
    #[tokio::test]
    async fn a_workload_s_named_objects_are_looked_up_the_same_way() {
        let page = page(marco(deployment()), "Deployment", "checkout-api")
            .await
            .expect("a page");
        assert_marco_sees(&page);
    }

    /// Would leave an expired session as three rows "not checked", with no
    /// sign-in asked for.
    #[tokio::test]
    async fn an_expired_session_on_a_named_lookup_ends_the_call() {
        let mut routes = marco(pod_list());
        routes.retain(|(path, _, _)| !path.ends_with("/serviceaccounts/default"));
        let (status, body) = failure(401, "Unauthorized");
        routes.push((
            "/api/v1/namespaces/team-checkout/serviceaccounts/default",
            status,
            body,
        ));
        let page = page(routes, "Pod", "checkout-api-6767fbfdb7-blpfk").await;
        assert!(
            matches!(page, Err(Error::CredentialsExpired(_))),
            "{page:?}"
        );
    }

    /// checkout-worker's pod as Marco's cluster has it: `DB_PASSWORD` from
    /// Secret checkout-db, which holds only password and username.
    fn worker(key: &str) -> Vec<(&'static str, u16, String)> {
        let spec = serde_json::json!({
            "containers": [{
                "name": "worker",
                "image": "ghcr.io/acme/checkout-worker:1.4.2",
                "env": [{
                    "name": "DB_PASSWORD",
                    "valueFrom": { "secretKeyRef": { "name": "checkout-db", "key": key } }
                }]
            }]
        });
        let pod = serde_json::json!({
            "metadata": { "name": "checkout-worker-7db8bc9ffd-km5ft", "namespace": NS },
            "spec": spec,
        });
        let deployment = serde_json::json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "checkout-worker", "namespace": NS },
            "spec": {
                "selector": { "matchLabels": { "app": "checkout-worker" } },
                "template": { "metadata": { "labels": { "app": "checkout-worker" } }, "spec": spec },
            },
        });
        let secret = serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": "checkout-db", "namespace": NS },
            "data": { "password": "cA==", "username": "dQ==" },
        });
        let pods = serde_json::json!({ "apiVersion": "v1", "kind": "List", "metadata": {}, "items": [pod] });
        vec![
            (
                "/api/v1/namespaces/team-checkout/pods",
                200,
                pods.to_string(),
            ),
            (
                "/apis/apps/v1/namespaces/team-checkout/deployments/checkout-worker",
                200,
                deployment.to_string(),
            ),
            (
                "/api/v1/namespaces/team-checkout/secrets/checkout-db",
                200,
                secret.to_string(),
            ),
        ]
    }

    fn key_present(page: &ResourceConnections) -> Option<bool> {
        let edge = page
            .edges
            .iter()
            .find(|edge| edge.to.kind == "Secret" && edge.to.name == "checkout-db")
            .expect("an edge to checkout-db");
        assert_eq!(edge.to.existence, Existence::Present);
        let Relation::Uses { usages } = &edge.relation else {
            panic!("{:?}", edge.relation)
        };
        let [Usage::Env { key_present, .. }] = usages.as_slice() else {
            panic!("{usages:?}")
        };
        *key_present
    }

    /// Marco's worker pod and Deployment listed checkout-db's `DB_PASSWORD` as
    /// fine while the Secret's own page said the key is not there. Fails if
    /// the pod's or the workload's lookup stops reading keys.
    #[tokio::test]
    async fn a_key_the_secret_lacks_is_missing_on_the_pod_and_its_deployment() {
        for (kind, name) in [
            ("Pod", "checkout-worker-7db8bc9ffd-km5ft"),
            ("Deployment", "checkout-worker"),
        ] {
            let page = page(worker("DB_PASSWORD"), kind, name)
                .await
                .expect("a page");
            assert_eq!(key_present(&page), Some(false), "{kind}");
        }
    }

    /// The same read finds a key that is there; fails if every key is called missing.
    #[tokio::test]
    async fn a_key_the_secret_holds_is_present_on_the_pod() {
        let page = page(
            worker("password"),
            "Pod",
            "checkout-worker-7db8bc9ffd-km5ft",
        )
        .await
        .expect("a page");
        assert_eq!(key_present(&page), Some(true));
    }
}
