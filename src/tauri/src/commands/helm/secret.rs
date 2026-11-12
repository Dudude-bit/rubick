//! Native helm-secret reads — list / detail / history. Helm 3 stores
//! each release as a Kubernetes Secret with `owner=helm` label and a
//! gzipped+base64'd JSON `release` blob inside `data`. Reading them
//! directly from the API server avoids the helm CLI dependency for
//! the read-only paths.

use crate::commands::helpers::{across, api_in, ResourceContext, Scoped};
use crate::error::{Error, PluginError, Result};
use crate::state::AppState;
use futures::StreamExt;
use k8s_openapi::api::core::v1::Secret;
use kube::api::ListParams;
use kube::Api;
use std::collections::HashMap;
use tauri::State;

use super::types::{HelmRelease, HelmReleaseDetail, HelmRevision, HelmSecretRelease};

/// Why a release secret would not decode, in the decoder's own words.
///
/// A plain `String`, not an `Error`: every caller either carries it as a fact
/// about one release — a row that says what it could not read — or wraps it
/// once. Returning an `Error` here meant the callers wrapped an already
/// formatted error, and the reader got `Plugin error: Plugin execution
/// failed:` twice in one sentence.
fn decode_helm_release(data: &[u8]) -> std::result::Result<HelmSecretRelease, String> {
    let json = crate::resources::stored_release_json(data)?;
    serde_json::from_slice(&json).map_err(|e| e.to_string())
}

/// The release a secret holds, or why it could not be read out of it. The one
/// way in, so a secret that will not read is an answer and never a skip.
fn release_in(secret: &Secret) -> std::result::Result<HelmSecretRelease, String> {
    let data = secret.data.as_ref().and_then(|data| data.get("release"));
    decode_helm_release(&data.ok_or("the secret has no `release` data")?.0)
}

/// The revision a release secret is labelled with, readable or not.
fn labelled_revision(secret: &Secret) -> i32 {
    let labels = secret.metadata.labels.as_ref();
    labels
        .and_then(|labels| labels.get("version"))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// The newest revision of a release, as the metadata list named it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Winner {
    namespace: String,
    secret: String,
    release: String,
    revision: i32,
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
) -> Vec<Winner> {
    let mut best: HashMap<(String, String), Winner> = HashMap::new();
    for (namespace, secret_name, labels) in entries {
        let Some(labels) = labels else { continue };
        let Some(release) = labels.get("name") else {
            continue;
        };
        let revision = labels
            .get("version")
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(0);
        let key = (namespace.to_string(), release.clone());
        if best.get(&key).is_some_and(|seen| seen.revision >= revision) {
            continue;
        }
        let winner = Winner {
            namespace: namespace.to_string(),
            secret: secret_name.to_string(),
            release: release.clone(),
            revision,
        };
        best.insert(key, winner);
    }
    best.into_values().collect()
}

/// The Helm page's read: the latest revision of every release in the scope,
/// from the release secrets themselves, one LIST per namespace.
#[tauri::command]
pub async fn list_helm_releases_in(
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Scoped<HelmRelease>> {
    let client = (*state.current_client()?).clone();
    crate::client::clock::timed(
        &state.perf,
        "listHelmReleasesIn",
        across(scope, |reach| releases_in(client.clone(), reach)),
    )
    .await
}

async fn releases_in(client: kube::Client, reach: Option<String>) -> Result<Vec<HelmRelease>> {
    let secrets: Api<Secret> = api_in(&client, reach.as_deref());

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

    let fetched = futures::stream::iter(winners)
        .map(|winner| {
            let client = client.clone();
            async move {
                let got = Api::<Secret>::namespaced(client, &winner.namespace)
                    .get(&winner.secret)
                    .await;
                (winner, got)
            }
        })
        .buffer_unordered(6)
        .collect::<Vec<_>>()
        .await;

    let mut releases = Vec::with_capacity(fetched.len());
    for (winner, got) in fetched {
        let read = match got {
            Ok(secret) => release_in(&secret),
            // Deleted between the metadata list and the get: a release that
            // changed under us. Any other failure is a release the list named
            // and this read did not reach, which is a row saying so.
            Err(kube::Error::Api(status)) if status.code == 404 => continue,
            Err(error) => match Error::from(error) {
                expired @ Error::CredentialsExpired(_) => return Err(expired),
                other => Err(other.to_string()),
            },
        };
        releases.push(row_of(winner, read));
    }
    releases.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));

    Ok(releases)
}

/// One row for one release the list named: what was read, or the release by
/// its labels with why it was not.
fn row_of(winner: Winner, read: std::result::Result<HelmSecretRelease, String>) -> HelmRelease {
    let blank = HelmRelease {
        name: winner.release,
        namespace: winner.namespace,
        revision: winner.revision,
        status: String::new(),
        chart: String::new(),
        app_version: None,
        updated: String::new(),
        source: "native".to_string(),
        suspended: None,
        source_ref: None,
        unreadable: None,
    };
    match read {
        Ok(release) => HelmRelease {
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
            ..blank
        },
        Err(why) => {
            tracing::warn!("Helm release {} was not read: {why}", blank.name);
            HelmRelease {
                unreadable: Some(why),
                ..blank
            }
        }
    }
}

#[cfg(test)]
mod tests {
    /// Vendor, release name, and the labels that vendor stamped on it.
    type LabelledRelease<'a> = (&'a str, &'a str, Option<&'a BTreeMap<String, String>>);

    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::collections::BTreeMap;

    fn labels(name: &str, version: &str) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("owner".to_string(), "helm".to_string()),
            ("name".to_string(), name.to_string()),
            ("version".to_string(), version.to_string()),
        ])
    }

    /// A cluster answering each path with one status and body.
    fn cluster(answers: Vec<(&'static str, u16, serde_json::Value)>) -> kube::Client {
        let service = tower::service_fn(move |request: http::Request<kube::client::Body>| {
            let (_, status, body) = answers
                .iter()
                .find(|(path, ..)| *path == request.uri().path())
                .unwrap_or_else(|| panic!("unexpected read of {}", request.uri()))
                .clone();
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(status)
                        .body(kube::client::Body::from(body.to_string().into_bytes()))
                        .unwrap(),
                )
            }
        });
        kube::Client::new(service, "default")
    }

    fn says(code: u16, reason: &str) -> serde_json::Value {
        serde_json::json!({
            "kind": "Status", "apiVersion": "v1", "metadata": {}, "status": "Failure",
            "message": format!("secrets is {reason}"), "reason": reason, "code": code,
        })
    }

    fn secret_name(release: &str, revision: i32) -> String {
        format!("sh.helm.release.v1.{release}.v{revision}")
    }

    /// The release secret Helm writes for one revision, payload and labels.
    fn stored(release: &str, revision: i32) -> serde_json::Value {
        let payload = serde_json::json!({
            "name": release, "namespace": "shop", "version": revision,
            "info": { "status": "deployed" },
            "chart": { "metadata": { "name": release, "version": "1.0.0" } },
        });
        serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": {
                "name": secret_name(release, revision), "namespace": "shop",
                "labels": labels(release, &revision.to_string()),
            },
            "data": { "release": STANDARD.encode(STANDARD.encode(payload.to_string())) },
        })
    }

    /// What the metadata list says of the same secrets.
    fn listed(releases: &[(&str, i32)]) -> serde_json::Value {
        let items: Vec<_> = releases
            .iter()
            .map(|(release, revision)| serde_json::json!({ "metadata": stored(release, *revision)["metadata"] }))
            .collect();
        serde_json::json!({
            "kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1",
            "metadata": {}, "items": items,
        })
    }

    /// A role that may list secrets and not get them, a timeout, a reset: the
    /// release was dropped with a log line, and with every get failing the
    /// page said the cluster has 0 releases. Only a 404 is a release gone.
    #[tokio::test]
    async fn a_release_whose_secret_could_not_be_fetched_is_a_row_saying_so() {
        let client = cluster(vec![
            (
                "/api/v1/secrets",
                200,
                listed(&[("api", 1), ("web", 3), ("gone", 2)]),
            ),
            (
                "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.api.v1",
                200,
                stored("api", 1),
            ),
            (
                "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.web.v3",
                403,
                says(403, "Forbidden"),
            ),
            (
                "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.gone.v2",
                404,
                says(404, "NotFound"),
            ),
        ]);

        let rows = releases_in(client, None).await.expect("the list was read");

        let seen: Vec<_> = rows
            .iter()
            .map(|row| (row.name.as_str(), row.revision, row.unreadable.is_some()))
            .collect();
        assert_eq!(seen, [("api", 1, false), ("web", 3, true)]);
        let why = rows[1].unreadable.as_deref().expect("why");
        assert!(why.contains("secrets is Forbidden"), "{why}");
    }

    /// A 401 is about the session, not one release. As a row it would sit in
    /// a tooltip, and nothing would notice the session had expired.
    #[tokio::test]
    async fn an_expired_session_fails_the_read_instead_of_marking_a_row() {
        let client = cluster(vec![
            ("/api/v1/secrets", 200, listed(&[("web", 3)])),
            (
                "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.web.v3",
                401,
                says(401, "Unauthorized"),
            ),
        ]);

        let failed = releases_in(client, None).await.expect_err("expired");

        assert!(matches!(failed, Error::CredentialsExpired(_)), "{failed}");
    }

    /// A revision that would not read was left out of the history: with a
    /// hole in it the history read as whole, and with nothing readable the
    /// page said Helm keeps none for the release.
    #[test]
    fn a_revision_that_will_not_read_stays_in_the_history_saying_so() {
        let secret = |revision| -> Secret {
            serde_json::from_value(stored("web", revision)).expect("a secret")
        };
        let mut garbled = secret(2);
        let payload = k8s_openapi::ByteString(b"not a release".to_vec());
        garbled.data = Some(BTreeMap::from([("release".to_string(), payload)]));
        let mut hollow = secret(3);
        hollow.data = None;

        let history = revisions_of([secret(1), garbled, hollow]);

        let seen: Vec<_> = history
            .iter()
            .map(|entry| (entry.revision, entry.unreadable.is_some()))
            .collect();
        assert_eq!(seen, [(3, true), (2, true), (1, false)]);
    }

    /// An older revision decoding is not an answer about a newer one that
    /// does not. The list row says revision 5 could not be read; opening it
    /// used to render revision 4's values and manifest as the release.
    #[test]
    fn refuses_a_stale_revision_when_the_newest_one_will_not_decode() {
        // Opening the row asks for the release, not a revision.
        assert!(shadows_the_answer(None, 4, 5));
        assert!(!shadows_the_answer(None, 5, 4));
        // Asked for one revision, only that revision shadows the answer.
        assert!(shadows_the_answer(Some(4), 5, 4));
        assert!(!shadows_the_answer(Some(5), 4, 3));
    }

    /// The reported release: one Secret template, the key given with
    /// `--set`, notes that print it. Its Values and Manifest tabs drew the
    /// key in full. Fails if anything a Helm read hands out carries it, as
    /// text or base64, or if the page is not told what was left out where.
    #[test]
    fn a_release_is_handed_out_with_its_private_key_withheld_and_named() {
        use crate::resources::{ReleaseWithheld, WithheldDocument, WithheldPart, WITHHELD_MARKER};
        const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");
        let manifest = format!(
            "---\n# Source: keys/templates/secret.yaml\napiVersion: v1\nkind: Secret\n\
             metadata: {{name: web-key}}\nstringData:\n  tls.key: {}\n  password: \"hunter2\"\n\
             ---\n# Source: keys/templates/encoded.yaml\napiVersion: v1\nkind: Secret\n\
             metadata:\n  name: web-encoded\ndata:\n  blob: {}\n",
            serde_json::to_string(KEY).expect("a string"),
            STANDARD.encode(KEY),
        );
        let mut secret = stored("web", 1);
        let payload = serde_json::json!({
            "name": "web", "namespace": "shop", "version": 1,
            "info": {
                "status": "deployed", "description": "Install complete",
                "notes": format!("The key in use:\n{KEY}"),
            },
            "chart": { "metadata": { "name": "keys", "version": "0.1.0" } },
            "config": { "password": "hunter2", "privateKey": KEY },
            "manifest": manifest,
        });
        secret["data"]["release"] = STANDARD.encode(STANDARD.encode(payload.to_string())).into();
        let secret: Secret = serde_json::from_value(secret).expect("a secret");
        let winner = Winner {
            namespace: "shop".to_string(),
            secret: secret_name("web", 1),
            release: "web".to_string(),
            revision: 1,
        };

        let detail = detail_of(release_in(&secret).expect("decodes"));
        let row = row_of(winner, release_in(&secret));
        let history = revisions_of([secret]);

        let handed = serde_json::json!([detail, row, history]).to_string();
        assert!(handed.contains("Install complete") && handed.contains("hunter2"));
        assert!(!handed.contains("PRIVATE KEY"), "{handed}");
        assert!(!handed.contains(&STANDARD.encode(KEY)[..64]), "{handed}");
        assert_eq!(detail.values["privateKey"], WITHHELD_MARKER);
        assert_eq!(detail.notes.as_deref(), Some(WITHHELD_MARKER));
        let document = |position, template: &str, name: &str, key: &str| WithheldDocument {
            position,
            source: Some(format!("keys/templates/{template}")),
            kind: Some("Secret".to_string()),
            name: Some(name.to_string()),
            what: WithheldPart::Keys {
                keys: vec![key.to_string()],
            },
        };
        assert_eq!(
            detail.withheld,
            ReleaseWithheld {
                values: vec!["privateKey".to_string()],
                manifest: vec![
                    document(1, "secret.yaml", "web-key", "tls.key"),
                    document(2, "encoded.yaml", "web-encoded", "blob"),
                ],
                notes: true,
            }
        );
    }

    /// A failed upgrade's one line is Helm's error, and Helm's error quotes
    /// the template it could not apply. Fails if the line leaves the detail
    /// or a history row with a key in it, or an ordinary line does not.
    #[test]
    fn a_releases_description_is_handed_out_without_a_key_it_quotes() {
        use crate::resources::WITHHELD_MARKER;
        const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");
        let with = |description: &str| {
            let mut secret = stored("web", 1);
            let payload = serde_json::json!({
                "name": "web", "namespace": "shop", "version": 1,
                "info": { "status": "failed", "description": description },
                "chart": { "metadata": { "name": "keys", "version": "0.1.0" } },
            });
            secret["data"]["release"] =
                STANDARD.encode(STANDARD.encode(payload.to_string())).into();
            serde_json::from_value::<Secret>(secret).expect("a secret")
        };
        let said = |secret: Secret| {
            let detail = detail_of(release_in(&secret).expect("decodes"));
            let history = revisions_of([secret]);
            (detail.description, history[0].description.clone())
        };

        let quoted = with(&format!(
            "Upgrade \"web\" failed: cannot patch \"web-key\": {KEY}"
        ));
        let marker = Some(WITHHELD_MARKER.to_string());
        assert_eq!(said(quoted), (marker.clone(), marker));
        let plain = Some("Install complete".to_string());
        assert_eq!(said(with("Install complete")), (plain.clone(), plain));
    }

    /// A release with no key in it is told nothing was withheld, and its
    /// notes, values and manifest are the ones Helm stored.
    #[test]
    fn a_release_with_no_private_key_is_handed_out_as_helm_stored_it() {
        let manifest = "---\n# Source: web/templates/cm.yaml\napiVersion: v1\nkind: ConfigMap\n\
                        metadata:\n  name: web\ndata:\n  level: debug # for now\n";
        let payload = serde_json::json!({
            "name": "web", "namespace": "shop", "version": 1,
            "info": { "status": "deployed", "notes": "1. Get the URL" },
            "chart": { "metadata": { "name": "web", "version": "1.0.0" } },
            "config": { "level": "debug" },
            "manifest": manifest,
        });
        let encoded = STANDARD.encode(payload.to_string());

        let detail = detail_of(decode_helm_release(encoded.as_bytes()).expect("decodes"));

        assert_eq!(
            detail.withheld,
            crate::resources::ReleaseWithheld::default()
        );
        assert_eq!(detail.manifest, manifest);
        assert_eq!(detail.values, serde_json::json!({ "level": "debug" }));
        assert_eq!(detail.notes.as_deref(), Some("1. Get the URL"));
    }

    /// A chart installed on its defaults, which is what Helm writes when
    /// nobody passed `--set` or `-f`: no `config` key at all. Requiring it
    /// made every such release fail to decode, and the list — which drops
    /// what it cannot read with a warning nobody sees — said the cluster
    /// had none. Reproduced against a real `helm install` on kind.
    #[test]
    fn reads_a_release_installed_with_no_values_of_its_own() {
        let json = br#"{
            "name": "shop-api",
            "namespace": "k8s-gui-test",
            "version": 1,
            "info": { "status": "deployed" },
            "chart": { "metadata": { "name": "shop-api", "version": "0.1.0" } }
        }"#;
        let encoded = STANDARD.encode(json);
        let release = decode_helm_release(encoded.as_bytes()).expect("decodes");
        assert_eq!(release.name, "shop-api");
        assert_eq!(release.shown().values, serde_json::Value::Null);
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
        let entries: Vec<LabelledRelease> = traefik
            .iter()
            .enumerate()
            .map(|(i, l)| ("traefik", TRAEFIK_NAMES[i], Some(l)))
            .chain([
                ("argocd", "sh.helm.release.v1.argocd.v1", Some(&argo[0])),
                ("argocd", "sh.helm.release.v1.argocd.v2", Some(&argo[1])),
            ])
            .collect();

        let mut winners: Vec<_> = latest_release_secrets(entries.into_iter())
            .into_iter()
            .map(|winner| (winner.namespace, winner.secret))
            .collect();
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
        let entries: Vec<LabelledRelease> = vec![
            ("backend", "sh.helm.release.v1.api.v3", Some(&one)),
            ("frontend", "sh.helm.release.v1.api.v5", Some(&two)),
            ("backend", "some-other-secret", None),
        ];

        let mut winners: Vec<_> = latest_release_secrets(entries.into_iter())
            .into_iter()
            .map(|winner| (winner.namespace, winner.secret))
            .collect();
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

/// Whether the secret that would not decode is the one the reader asked for.
///
/// Asked for a revision, it is that revision. Asked for the release — which
/// is what opening a row does — it is any revision newer than the newest one
/// that did decode. Answering with an older revision's values and manifest
/// would present yesterday's release as today's, on the very page opened
/// from a row that correctly said it could not be read.
fn shadows_the_answer(asked: Option<i32>, newest_decoded: i32, unreadable_at: i32) -> bool {
    match asked {
        Some(target) => unreadable_at == target,
        None => unreadable_at > newest_decoded,
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
    crate::client::clock::timed(
        &state.perf,
        "getHelmReleaseDetail",
        release_detail(&state, name, namespace, revision),
    )
    .await
}

async fn release_detail(
    state: &AppState,
    name: String,
    namespace: String,
    revision: Option<i32>,
) -> Result<HelmReleaseDetail> {
    let ctx = ResourceContext::for_command(state, Some(namespace.clone()))?;
    let secrets: Api<Secret> = ctx.namespaced_api();

    // Find the specific revision or latest
    let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
    let secret_list = secrets.list(&lp).await?;

    let mut target_release: Option<HelmSecretRelease> = None;
    let mut max_revision = 0;
    // A secret that is there and will not decode is not a release that is
    // not there. Dropping both into one answer made "not found" — which the
    // frontend paints as "this may be gone" — the report for a release the
    // cluster holds and this app could not read.
    //
    // Carried with its revision, from the label, because an older revision
    // decoding is not an answer about a newer one that does not: handing
    // back revision 4 as "the release" while the list row correctly says
    // revision 5 is unreadable is the same lie one page further on.
    let mut unreadable: Option<(i32, String)> = None;

    for secret in secret_list {
        let at = labelled_revision(&secret);
        match release_in(&secret) {
            Ok(release) => {
                if let Some(target_rev) = revision {
                    if release.version == target_rev {
                        target_release = Some(release);
                    }
                } else if release.version > max_revision {
                    max_revision = release.version;
                    target_release = Some(release);
                }
            }
            Err(error) => {
                tracing::warn!("Failed to decode Helm release secret: {error}");
                if unreadable.as_ref().is_none_or(|(seen, _)| at > *seen) {
                    unreadable = Some((at, error));
                }
            }
        }
    }

    let shadowed = unreadable
        .as_ref()
        .is_some_and(|(at, _)| shadows_the_answer(revision, max_revision, *at));

    let release = match (target_release, unreadable) {
        (Some(_), Some((_, why))) if shadowed => {
            return Err(Error::Plugin(PluginError::ExecutionFailed(format!(
                "Release {name} in namespace {namespace} could not be read: {why}"
            ))))
        }
        (Some(release), _) => release,
        (None, Some((_, why))) => {
            return Err(Error::Plugin(PluginError::ExecutionFailed(format!(
                "Release {name} in namespace {namespace} could not be read: {why}"
            ))))
        }
        (None, None) => {
            return Err(Error::Plugin(PluginError::ExecutionFailed(format!(
                "Release {name} not found in namespace {namespace}"
            ))))
        }
    };

    Ok(detail_of(release))
}

fn detail_of(release: HelmSecretRelease) -> HelmReleaseDetail {
    let shown = release.shown();
    HelmReleaseDetail {
        name: release.name,
        namespace: release.namespace,
        revision: release.version,
        description: release.info.description(),
        status: release.info.status,
        chart: release.chart.metadata.name.clone(),
        chart_version: release.chart.metadata.version,
        app_version: release.chart.metadata.app_version,
        first_deployed: release.info.first_deployed,
        last_deployed: release.info.last_deployed,
        values: shown.values,
        manifest: shown.manifest,
        notes: shown.notes,
        withheld: shown.withheld,
    }
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
    crate::client::clock::timed(
        &state.perf,
        "getHelmHistory",
        release_history(&state, name, namespace),
    )
    .await
}

async fn release_history(
    state: &AppState,
    name: String,
    namespace: String,
) -> Result<Vec<HelmRevision>> {
    let ctx = ResourceContext::for_command(state, Some(namespace.clone()))?;
    let secrets: Api<Secret> = ctx.namespaced_api();

    let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
    Ok(revisions_of(secrets.list(&lp).await?))
}

/// Every revision the cluster holds, newest first. One that will not decode
/// is a row by its label: left out, a history with a hole in it reads as
/// whole, and one with nothing readable as a release Helm keeps none for.
fn revisions_of(secrets: impl IntoIterator<Item = Secret>) -> Vec<HelmRevision> {
    let mut history: Vec<HelmRevision> = secrets
        .into_iter()
        .map(|secret| match release_in(&secret) {
            Ok(release) => HelmRevision {
                revision: release.version,
                description: release.info.description(),
                updated: release.info.last_deployed.unwrap_or_default(),
                status: release.info.status,
                chart: format!(
                    "{}-{}",
                    release.chart.metadata.name, release.chart.metadata.version
                ),
                app_version: release.chart.metadata.app_version,
                unreadable: None,
            },
            Err(why) => HelmRevision {
                revision: labelled_revision(&secret),
                updated: String::new(),
                status: String::new(),
                chart: String::new(),
                app_version: None,
                description: None,
                unreadable: Some(why),
            },
        })
        .collect();
    history.sort_by_key(|entry| std::cmp::Reverse(entry.revision));
    history
}
