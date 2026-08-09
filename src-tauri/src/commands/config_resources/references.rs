//! "Find references" — given a ConfigMap, a Secret or a claim, scan
//! workloads and ingresses for env vars / envFrom / volumes /
//! imagePullSecrets / TLS that target it.
//!
//! The matching itself is `usages_in_pod_spec`, shared with the connections
//! command. It reads volumes through the same `volume_source` the pod detail
//! page uses, which is what gives this a claim case at all: the hand-rolled
//! scan it replaced looked only at `volume.configMap` and `volume.secret`, so
//! a claim in use reported that nothing used it.

use crate::commands::helpers::ResourceContext;
use crate::error::Result;
use crate::resources::{usages_in_pod_spec, Usage};
use crate::state::AppState;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Pod, PodSpec};
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::ListParams;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReference {
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub container_name: Option<String>,
    pub key: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VolumeReference {
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub container_name: Option<String>,
    pub mount_path: String,
    pub sub_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IngressReference {
    pub name: String,
    pub namespace: String,
    pub hosts: Vec<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReferences {
    pub env_vars: Vec<ResourceReference>,
    pub env_from: Vec<ResourceReference>,
    pub volumes: Vec<VolumeReference>,
    pub image_pull_secrets: Vec<ResourceReference>,
    pub tls_ingress: Vec<IngressReference>,
}

/// Get resources that reference a Secret or `ConfigMap`
#[tauri::command]
pub async fn get_resource_references(
    resource_type: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ResourceReferences> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace.clone())?;
    let ns = ctx
        .namespace
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let target_kind = target_kind(&resource_type);
    let is_secret = target_kind == "Secret";
    let target_name = name.clone();

    // Create all APIs
    let pods_api: kube::Api<Pod> = kube::Api::namespaced(ctx.client.clone(), &ns);
    let deploy_api: kube::Api<Deployment> = kube::Api::namespaced(ctx.client.clone(), &ns);
    let sts_api: kube::Api<StatefulSet> = kube::Api::namespaced(ctx.client.clone(), &ns);
    let ds_api: kube::Api<DaemonSet> = kube::Api::namespaced(ctx.client.clone(), &ns);
    let job_api: kube::Api<Job> = kube::Api::namespaced(ctx.client.clone(), &ns);
    let cj_api: kube::Api<CronJob> = kube::Api::namespaced(ctx.client.clone(), &ns);
    let ingress_api: kube::Api<Ingress> = kube::Api::namespaced(ctx.client.clone(), &ns);

    let params = ListParams::default();

    // Fetch all resources in parallel
    let (pods_res, deploys_res, stss_res, dss_res, jobs_res, cjs_res, ingresses_res) = tokio::join!(
        pods_api.list(&params),
        deploy_api.list(&params),
        sts_api.list(&params),
        ds_api.list(&params),
        job_api.list(&params),
        cj_api.list(&params),
        ingress_api.list(&params),
    );

    let mut refs = ResourceReferences::default();

    // Process Pods
    if let Ok(pods) = pods_res {
        for pod in pods.items {
            if let Some(spec) = &pod.spec {
                let pod_name = pod.metadata.name.clone().unwrap_or_default();
                check_pod_spec(
                    spec,
                    "Pod",
                    &pod_name,
                    &ns,
                    target_kind,
                    &target_name,
                    &mut refs,
                );
            }
        }
    }

    // Process Deployments
    if let Ok(deploys) = deploys_res {
        for deploy in deploys.items {
            if let Some(spec) = deploy.spec.as_ref().and_then(|s| s.template.spec.as_ref()) {
                let deploy_name = deploy.metadata.name.clone().unwrap_or_default();
                check_pod_spec(
                    spec,
                    "Deployment",
                    &deploy_name,
                    &ns,
                    target_kind,
                    &target_name,
                    &mut refs,
                );
            }
        }
    }

    // Process StatefulSets
    if let Ok(stss) = stss_res {
        for sts in stss.items {
            if let Some(spec) = sts.spec.as_ref().and_then(|s| s.template.spec.as_ref()) {
                let sts_name = sts.metadata.name.clone().unwrap_or_default();
                check_pod_spec(
                    spec,
                    "StatefulSet",
                    &sts_name,
                    &ns,
                    target_kind,
                    &target_name,
                    &mut refs,
                );
            }
        }
    }

    // Process DaemonSets
    if let Ok(dss) = dss_res {
        for ds in dss.items {
            if let Some(spec) = ds.spec.as_ref().and_then(|s| s.template.spec.as_ref()) {
                let ds_name = ds.metadata.name.clone().unwrap_or_default();
                check_pod_spec(
                    spec,
                    "DaemonSet",
                    &ds_name,
                    &ns,
                    target_kind,
                    &target_name,
                    &mut refs,
                );
            }
        }
    }

    // Process Jobs
    if let Ok(jobs) = jobs_res {
        for job in jobs.items {
            if let Some(spec) = job.spec.as_ref().and_then(|s| s.template.spec.as_ref()) {
                let job_name = job.metadata.name.clone().unwrap_or_default();
                check_pod_spec(
                    spec,
                    "Job",
                    &job_name,
                    &ns,
                    target_kind,
                    &target_name,
                    &mut refs,
                );
            }
        }
    }

    // Process CronJobs
    if let Ok(cjs) = cjs_res {
        for cj in cjs.items {
            if let Some(spec) = cj
                .spec
                .as_ref()
                .and_then(|s| s.job_template.spec.as_ref())
                .and_then(|s| s.template.spec.as_ref())
            {
                let cj_name = cj.metadata.name.clone().unwrap_or_default();
                check_pod_spec(
                    spec,
                    "CronJob",
                    &cj_name,
                    &ns,
                    target_kind,
                    &target_name,
                    &mut refs,
                );
            }
        }
    }

    // Process Ingress TLS (only for secrets)
    if is_secret {
        if let Ok(ingresses) = ingresses_res {
            for ingress in ingresses.items {
                if let Some(spec) = &ingress.spec {
                    if let Some(tls_configs) = &spec.tls {
                        for tls in tls_configs {
                            if tls.secret_name.as_ref() == Some(&target_name) {
                                refs.tls_ingress.push(IngressReference {
                                    name: ingress.metadata.name.clone().unwrap_or_default(),
                                    namespace: ns.clone(),
                                    hosts: tls.hosts.clone().unwrap_or_default(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(refs)
}

/// Which kind the caller means. A claim used to fall through to the
/// ConfigMap branch and match nothing, which is how a claim in use reported
/// that nothing used it.
fn target_kind(resource_type: &str) -> &'static str {
    match resource_type.to_lowercase().as_str() {
        "secret" => "Secret",
        "persistentvolumeclaim" | "pvc" => "PersistentVolumeClaim",
        _ => "ConfigMap",
    }
}

/// Fold every use of one object into the shapes this command's callers
/// already render. `Unmounted`, `Identity` and `IngressTls` have no slot
/// here — the first two are new facts nothing asked for, and TLS is
/// collected from the Ingress list above.
fn check_pod_spec(
    spec: &PodSpec,
    kind: &str,
    resource_name: &str,
    resource_ns: &str,
    target_kind: &str,
    target_name: &str,
    refs: &mut ResourceReferences,
) {
    let reference = |container_name: Option<String>, key: Option<String>| ResourceReference {
        kind: kind.to_string(),
        name: resource_name.to_string(),
        namespace: resource_ns.to_string(),
        container_name,
        key,
    };

    for usage in usages_in_pod_spec(spec, target_kind, target_name) {
        match usage {
            Usage::Mount {
                container,
                path,
                sub_path,
                ..
            } => refs.volumes.push(VolumeReference {
                kind: kind.to_string(),
                name: resource_name.to_string(),
                namespace: resource_ns.to_string(),
                container_name: Some(container),
                mount_path: path,
                sub_path,
            }),
            Usage::Env {
                container,
                name: _,
                key,
            } => refs.env_vars.push(reference(Some(container), Some(key))),
            Usage::EnvFrom { container } => refs.env_from.push(reference(Some(container), None)),
            Usage::ImagePullSecret => refs.image_pull_secrets.push(reference(None, None)),
            Usage::Unmounted { .. } | Usage::Identity | Usage::IngressTls { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claim_is_its_own_kind_and_not_a_configmap() {
        assert_eq!(
            target_kind("PersistentVolumeClaim"),
            "PersistentVolumeClaim"
        );
        assert_eq!(target_kind("pvc"), "PersistentVolumeClaim");
        assert_eq!(target_kind("Secret"), "Secret");
        assert_eq!(target_kind("ConfigMap"), "ConfigMap");
    }

    #[test]
    fn a_claim_volume_reaches_the_reference_list() {
        let spec = PodSpec {
            volumes: Some(vec![k8s_openapi::api::core::v1::Volume {
                name: "data".to_string(),
                persistent_volume_claim: Some(
                    k8s_openapi::api::core::v1::PersistentVolumeClaimVolumeSource {
                        claim_name: "pvc-demo".to_string(),
                        read_only: None,
                    },
                ),
                ..Default::default()
            }]),
            containers: vec![k8s_openapi::api::core::v1::Container {
                name: "app".to_string(),
                volume_mounts: Some(vec![k8s_openapi::api::core::v1::VolumeMount {
                    name: "data".to_string(),
                    mount_path: "/var/lib/data".to_string(),
                    ..Default::default()
                }]),
                ..Default::default()
            }],
            ..Default::default()
        };

        let mut refs = ResourceReferences::default();
        check_pod_spec(
            &spec,
            "Deployment",
            "mounts-demo",
            "k8s-gui-test",
            target_kind("pvc"),
            "pvc-demo",
            &mut refs,
        );

        assert_eq!(refs.volumes.len(), 1);
        assert_eq!(refs.volumes[0].name, "mounts-demo");
        assert_eq!(refs.volumes[0].mount_path, "/var/lib/data");
    }
}
