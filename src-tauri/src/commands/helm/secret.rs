//! Native helm-secret reads — list / detail / history. Helm 3 stores
//! each release as a Kubernetes Secret with `owner=helm` label and a
//! gzipped+base64'd JSON `release` blob inside `data`. Reading them
//! directly from the API server avoids the helm CLI dependency for
//! the read-only paths.

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, PluginError, Result};
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::read::GzDecoder;
use futures::StreamExt;
use k8s_openapi::api::core::v1::Secret;
use kube::api::ListParams;
use kube::Api;
use std::collections::HashMap;
use std::io::Read;
use tauri::State;

use super::types::{HelmRelease, HelmReleaseDetail, HelmRevision, HelmSecretRelease};

/// Decode Helm release from Kubernetes Secret data
fn decode_helm_release(data: &[u8]) -> Result<HelmSecretRelease> {
    // Base64 decode
    let compressed = STANDARD.decode(data).map_err(|e| {
        Error::Plugin(PluginError::ExecutionFailed(format!(
            "Base64 decode error: {e}"
        )))
    })?;

    // Check for gzip magic bytes and decompress
    let json_bytes = if compressed.len() >= 2 && compressed[0] == 0x1f && compressed[1] == 0x8b {
        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).map_err(|e| {
            Error::Plugin(PluginError::ExecutionFailed(format!(
                "Gzip decompress error: {e}"
            )))
        })?;
        decompressed
    } else {
        // Old format: not compressed
        compressed
    };

    // Parse JSON
    serde_json::from_slice(&json_bytes).map_err(|e| {
        Error::Plugin(PluginError::ExecutionFailed(format!(
            "JSON parse error: {e}"
        )))
    })
}

/// The newest revision of each release, picked from metadata alone.
///
/// Helm labels every release Secret with `name` and `version`, so the
/// winners are known before a single payload is transferred — and the
/// payloads are the whole cost: each revision carries the release's full
/// gzipped chart, so listing them whole transfers a history of blobs to
/// throw all but one of each away. Versions compare as numbers, because
/// `"10"` loses to `"9"` as a string.
fn latest_release_secrets<'a>(
    entries: impl Iterator<
        Item = (
            &'a str,
            &'a str,
            Option<&'a std::collections::BTreeMap<String, String>>,
        ),
    >,
) -> Vec<(String, String)> {
    let mut best: HashMap<(String, String), (i64, String)> = HashMap::new();
    for (namespace, secret_name, labels) in entries {
        let Some(labels) = labels else { continue };
        let Some(release) = labels.get("name") else {
            continue;
        };
        let version = labels
            .get("version")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        let key = (namespace.to_string(), release.clone());
        match best.get(&key) {
            Some((seen, _)) if *seen >= version => {}
            _ => {
                best.insert(key, (version, secret_name.to_string()));
            }
        }
    }
    best.into_iter()
        .map(|((namespace, _), (_, secret_name))| (namespace, secret_name))
        .collect()
}

/// List Helm releases using native Kubernetes API (reads Helm secrets directly)
#[tauri::command]
pub async fn list_helm_releases_native(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<HelmRelease>> {
    let ctx = ResourceContext::for_list(&state, namespace)?;

    let secrets: Api<Secret> = ctx.namespaced_or_cluster_api();

    // Metadata first, payloads for the winners only: this list used to
    // fetch every revision of every release whole — on the reported
    // cluster half the transfer was superseded blobs decoded and thrown
    // away, and the page took seven seconds to say five names.
    let lp = ListParams::default().labels("owner=helm");
    let metas = secrets.list_metadata(&lp).await?;
    let winners = latest_release_secrets(metas.items.iter().filter_map(|meta| {
        Some((
            meta.metadata.namespace.as_deref()?,
            meta.metadata.name.as_deref()?,
            meta.metadata.labels.as_ref(),
        ))
    }));

    let client = ctx.client.clone();
    let fetched = futures::stream::iter(winners)
        .map(|(namespace, name)| {
            let client = client.clone();
            async move {
                Api::<Secret>::namespaced(client, &namespace)
                    .get(&name)
                    .await
            }
        })
        .buffer_unordered(6)
        .collect::<Vec<_>>()
        .await;

    let mut releases_map: HashMap<(String, String), HelmRelease> = HashMap::new();

    for secret in fetched.into_iter().filter_map(|result| match result {
        Ok(secret) => Some(secret),
        Err(error) => {
            // A revision deleted between the metadata list and the get is
            // a release that changed under us, not a page that failed.
            tracing::warn!("Failed to fetch Helm release secret: {}", error);
            None
        }
    }) {
        if let Some(data) = secret.data {
            if let Some(release_data) = data.get("release") {
                match decode_helm_release(&release_data.0) {
                    Ok(release) => {
                        let key = (release.namespace.clone(), release.name.clone());

                        // Keep only the latest revision for each release
                        let should_insert = releases_map
                            .get(&key)
                            .is_none_or(|existing| release.version > existing.revision);

                        if should_insert {
                            let helm_release = HelmRelease {
                                name: release.name,
                                namespace: release.namespace,
                                revision: release.version,
                                status: release.info.status,
                                chart: format!(
                                    "{}-{}",
                                    release.chart.metadata.name, release.chart.metadata.version
                                ),
                                app_version: release.chart.metadata.app_version,
                                updated: release.info.last_deployed.unwrap_or_default(),
                                source: "native".to_string(),
                                suspended: None,
                                source_ref: None,
                            };
                            releases_map.insert(key, helm_release);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to decode Helm release secret: {}", e);
                    }
                }
            }
        }
    }

    let mut releases: Vec<HelmRelease> = releases_map.into_values().collect();
    releases.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));

    Ok(releases)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn labels(name: &str, version: &str) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("owner".to_string(), "helm".to_string()),
            ("name".to_string(), name.to_string()),
            ("version".to_string(), version.to_string()),
        ])
    }

    /// A history of superseded revisions must cost one fetch, not ten —
    /// and the tenth beats the ninth numerically, where a string compare
    /// would hand the win to `"9"`.
    #[test]
    fn picks_the_newest_revision_of_each_release() {
        let traefik: Vec<BTreeMap<String, String>> = (1..=10)
            .map(|v| labels("traefik", &v.to_string()))
            .collect();
        let argo = [labels("argocd", "1"), labels("argocd", "2")];
        let entries: Vec<(&str, &str, Option<&BTreeMap<String, String>>)> = traefik
            .iter()
            .enumerate()
            .map(|(i, l)| ("traefik", TRAEFIK_NAMES[i], Some(l)))
            .chain([
                ("argocd", "sh.helm.release.v1.argocd.v1", Some(&argo[0])),
                ("argocd", "sh.helm.release.v1.argocd.v2", Some(&argo[1])),
            ])
            .collect();

        let mut winners = latest_release_secrets(entries.into_iter());
        winners.sort();
        assert_eq!(
            winners,
            vec![
                (
                    "argocd".to_string(),
                    "sh.helm.release.v1.argocd.v2".to_string()
                ),
                (
                    "traefik".to_string(),
                    "sh.helm.release.v1.traefik.v10".to_string()
                ),
            ]
        );
    }

    const TRAEFIK_NAMES: [&str; 10] = [
        "sh.helm.release.v1.traefik.v1",
        "sh.helm.release.v1.traefik.v2",
        "sh.helm.release.v1.traefik.v3",
        "sh.helm.release.v1.traefik.v4",
        "sh.helm.release.v1.traefik.v5",
        "sh.helm.release.v1.traefik.v6",
        "sh.helm.release.v1.traefik.v7",
        "sh.helm.release.v1.traefik.v8",
        "sh.helm.release.v1.traefik.v9",
        "sh.helm.release.v1.traefik.v10",
    ];

    /// Two releases wearing one name in different namespaces are two
    /// releases; a secret with no helm `name` label is none at all.
    #[test]
    fn keeps_namespaces_apart_and_skips_the_unlabelled() {
        let one = labels("api", "3");
        let two = labels("api", "5");
        let entries: Vec<(&str, &str, Option<&BTreeMap<String, String>>)> = vec![
            ("backend", "sh.helm.release.v1.api.v3", Some(&one)),
            ("frontend", "sh.helm.release.v1.api.v5", Some(&two)),
            ("backend", "some-other-secret", None),
        ];

        let mut winners = latest_release_secrets(entries.into_iter());
        winners.sort();
        assert_eq!(
            winners,
            vec![
                (
                    "backend".to_string(),
                    "sh.helm.release.v1.api.v3".to_string()
                ),
                (
                    "frontend".to_string(),
                    "sh.helm.release.v1.api.v5".to_string()
                ),
            ]
        );
    }
}

/// Get Helm release detail (values, manifest, notes)
#[tauri::command]
pub async fn get_helm_release_detail(
    name: String,
    namespace: String,
    revision: Option<i32>,
    state: State<'_, AppState>,
) -> Result<HelmReleaseDetail> {
    crate::validation::validate_dns_subdomain(&name)?;
    crate::validation::validate_namespace(&namespace)?;
    let ctx = ResourceContext::for_command(&state, Some(namespace.clone()))?;
    let secrets: Api<Secret> = ctx.namespaced_api();

    // Find the specific revision or latest
    let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
    let secret_list = secrets.list(&lp).await?;

    let mut target_release: Option<HelmSecretRelease> = None;
    let mut max_revision = 0;

    for secret in secret_list {
        if let Some(data) = secret.data {
            if let Some(release_data) = data.get("release") {
                if let Ok(release) = decode_helm_release(&release_data.0) {
                    if let Some(target_rev) = revision {
                        if release.version == target_rev {
                            target_release = Some(release);
                            break;
                        }
                    } else if release.version > max_revision {
                        max_revision = release.version;
                        target_release = Some(release);
                    }
                }
            }
        }
    }

    let release = target_release.ok_or_else(|| {
        Error::Plugin(PluginError::ExecutionFailed(format!(
            "Release {name} not found in namespace {namespace}"
        )))
    })?;

    Ok(HelmReleaseDetail {
        name: release.name,
        namespace: release.namespace,
        revision: release.version,
        status: release.info.status,
        chart: release.chart.metadata.name.clone(),
        chart_version: release.chart.metadata.version,
        app_version: release.chart.metadata.app_version,
        first_deployed: release.info.first_deployed,
        last_deployed: release.info.last_deployed,
        description: release.info.description,
        values: release.config,
        manifest: release.manifest,
        notes: release.info.notes,
    })
}

/// Get Helm release history
#[tauri::command]
pub async fn get_helm_history(
    name: String,
    namespace: String,
    state: State<'_, AppState>,
) -> Result<Vec<HelmRevision>> {
    crate::validation::validate_dns_subdomain(&name)?;
    crate::validation::validate_namespace(&namespace)?;
    let ctx = ResourceContext::for_command(&state, Some(namespace.clone()))?;
    let secrets: Api<Secret> = ctx.namespaced_api();

    let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
    let secret_list = secrets.list(&lp).await?;

    let mut history: Vec<HelmRevision> = Vec::new();

    for secret in secret_list {
        if let Some(data) = secret.data {
            if let Some(release_data) = data.get("release") {
                if let Ok(release) = decode_helm_release(&release_data.0) {
                    history.push(HelmRevision {
                        revision: release.version,
                        updated: release.info.last_deployed.unwrap_or_default(),
                        status: release.info.status,
                        chart: format!(
                            "{}-{}",
                            release.chart.metadata.name, release.chart.metadata.version
                        ),
                        app_version: release.chart.metadata.app_version,
                        description: release.info.description,
                    });
                }
            }
        }
    }

    // Sort by revision descending (newest first)
    history.sort_by(|a, b| b.revision.cmp(&a.revision));

    Ok(history)
}
