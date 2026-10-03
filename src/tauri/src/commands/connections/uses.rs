//! What a pod needs to run: the `ConfigMaps`, Secrets, claims and identity its
//! spec names.

use super::*;

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

/// A name a pod spec states, resolved as far as this call actually looked.
///
/// Claims that were listed carry their phase and size and can be called
/// present or missing. `ConfigMaps`, Secrets and `ServiceAccounts` were never
/// listed, and saying `notChecked` is the difference between "the app did not
/// ask" and "the cluster does not have it".
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
