//! Tauri commands for manifest validate / apply / delete / get.

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::state::AppState;
use kube::api::{Patch, PatchParams};
use tauri::State;

use super::parse::{api_resource_for, is_cluster_scoped, parse_all_documents};
use super::{DryRun, DryRunDocument, DryRunOutcome, ManifestResult};

/// Validate a Kubernetes manifest (parse and check structure).
///
/// This performs client-side validation of the manifest without applying it.
#[tauri::command]
pub async fn validate_manifest(
    manifest: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ManifestResult> {
    let parsed_docs = match parse_all_documents(&manifest) {
        Ok(docs) => docs,
        Err(e) => return Ok(ManifestResult::error(e.to_string())),
    };

    let results: Vec<String> = parsed_docs
        .iter()
        .map(|p| p.format_id(&p.effective_namespace(namespace.as_deref()), "validated"))
        .collect();

    // Verify we have a connection for server-side validation
    if state.get_current_context().is_none() {
        return Ok(ManifestResult::error(
            "No cluster connected. Client-side validation passed, but server validation skipped."
                .to_string(),
        ));
    }

    Ok(ManifestResult::success(format!(
        "Validation passed:\n{}",
        results.join("\n")
    )))
}

/// Apply a Kubernetes manifest to the cluster using server-side apply
#[tauri::command]
pub async fn apply_manifest(
    manifest: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ManifestResult> {
    let parsed_docs = match parse_all_documents(&manifest) {
        Ok(docs) => docs,
        Err(e) => return Ok(ManifestResult::error(e.to_string())),
    };

    let mut results = Vec::new();
    let patch_params = PatchParams::apply("k8s-gui").force();

    for parsed in parsed_docs {
        let ns = parsed.effective_namespace(namespace.as_deref());
        let name = parsed.name();
        let ctx = ResourceContext::for_command(&state, Some(ns.clone()))?;
        let api = ctx.dynamic_api_for_resource(
            &parsed.api_resource,
            is_cluster_scoped(&parsed.api_resource.kind),
        );

        match api
            .patch(&name, &patch_params, &Patch::Apply(&parsed.object))
            .await
        {
            Ok(_) => results.push(parsed.format_id(&ns, "configured")),
            Err(e) => {
                return Ok(ManifestResult::error(format!(
                    "Failed to apply {}: {}",
                    parsed.format_id(&ns, ""),
                    e
                )));
            }
        }
    }

    Ok(ManifestResult::success(results.join("\n")))
}

/// What the object looks like right now, before the dry run touched it.
enum Live {
    Present(String),
    Absent,
    /// Could not be read. Not the same as absent: a 403 here drawn as
    /// "would be created" tells a person they are about to make something
    /// that already exists.
    Unread(String),
}

/// The YAML the editor would show for this object: private keys redacted,
/// server bookkeeping stripped. The same path `get_manifest` takes, so the
/// two sides of the diff are cleaned alike and a Secret stays a Secret.
fn editor_yaml(object: &kube::core::DynamicObject) -> Result<String> {
    let mut value =
        serde_json::to_value(object).map_err(|e| Error::Serialization(e.to_string()))?;
    crate::resources::redact_private_keys(&mut value);
    let yaml = serde_yaml::to_string(&value).map_err(|e| Error::Serialization(e.to_string()))?;
    crate::commands::helpers::clean_yaml_for_editor(&yaml)
}

/// How the dry run itself ended when it did not end in an object.
enum NoAnswer {
    /// The server read the manifest and said no: a 4xx with a `Status`.
    Refused(String),
    /// The server was never really asked, or never answered.
    Unanswered(String),
}

/// What a failed read of the current object means.
///
/// The one place the third state is actually built, and until now it was
/// reachable only through a live cluster: every unit test made `Absent` and
/// `Unread` by hand, so swapping the two arms changed nothing anybody ran.
/// A 404 is the object not being there; anything else is nobody having
/// looked, and the two are opposite answers.
fn live_failure(err: kube::Error) -> Live {
    match err {
        kube::Error::Api(status) if status.code == 404 => Live::Absent,
        other => {
            let said = Error::from(other);
            // The marker is a wire format, not a sentence: this string is
            // rendered as prose beside the reader's own language, and
            // `READ_DEADLINE: …` there is the app's plumbing on screen.
            let text = said.to_string();
            Live::Unread(
                text.strip_prefix("READ_DEADLINE: ")
                    .unwrap_or(&text)
                    .to_string(),
            )
        }
    }
}

/// A 401 is the session being over, not the server refusing this manifest.
///
/// It reaches every document and every other command equally, the app has
/// one path for it, and that path starts with the command failing so the
/// wrapper can see the `CREDENTIALS_EXPIRED:` marker. Classified as a
/// refusal it blocked Apply — a sign-in problem dressed as the cluster
/// rejecting the reader's YAML — and put the wire marker on screen as prose.
fn session_over(err: &kube::Error) -> bool {
    matches!(err, kube::Error::Api(status) if status.code == 401)
}

/// What the live read means, or the one failure that is not about the
/// document at all.
///
/// The 401 arm is the point: filed with the 4xx refusals it blocks Apply as
/// though the cluster had rejected the YAML and puts the
/// `CREDENTIALS_EXPIRED:` wire marker on screen as the server's own words.
/// It lives here rather than inline in the loop because there it was one
/// `if` guard that could be deleted with the whole suite green — the loop
/// runs only against a cluster.
fn live_of(
    read: std::result::Result<kube::core::DynamicObject, kube::Error>,
) -> Result<(Live, Option<kube::core::DynamicObject>)> {
    match read {
        Ok(object) => {
            let yaml = editor_yaml(&object)?;
            Ok((Live::Present(yaml), Some(object)))
        }
        Err(e) if session_over(&e) => Err(Error::from(e)),
        Err(e) => Ok((live_failure(e), None)),
    }
}

/// The same door for the dry-run apply itself.
#[allow(clippy::type_complexity)]
fn would_of(
    applied: std::result::Result<kube::core::DynamicObject, kube::Error>,
) -> Result<(
    std::result::Result<String, NoAnswer>,
    Option<kube::core::DynamicObject>,
)> {
    match applied {
        Ok(object) => {
            let yaml = editor_yaml(&object)?;
            Ok((Ok(yaml), Some(object)))
        }
        Err(e) if session_over(&e) => Err(Error::from(e)),
        Err(e) => Ok((Err(no_answer(e)), None)),
    }
}

fn no_answer(err: kube::Error) -> NoAnswer {
    let said = Error::from(err_ref_clone(&err)).to_string();
    match err {
        kube::Error::Api(status) if (400..500).contains(&status.code) => NoAnswer::Refused(said),
        _ => NoAnswer::Unanswered(said),
    }
}

/// `kube::Error` is not `Clone`; the display is what is wanted, and the
/// `From` impl that cleans it takes the error by value.
fn err_ref_clone(err: &kube::Error) -> kube::Error {
    match err {
        kube::Error::Api(status) => kube::Error::Api(status.clone()),
        other => kube::Error::Service(other.to_string().into()),
    }
}

/// Which of the six answers this document gets.
/// Whether applying would leave the object as it is.
///
/// Compared on the objects themselves and with the bookkeeping the server
/// rewrites on every write taken out, so a resourceVersion that moved is
/// not a change and a rotated private key is.
fn unchanged(now: &kube::core::DynamicObject, after: &kube::core::DynamicObject) -> bool {
    fn comparable(object: &kube::core::DynamicObject) -> serde_json::Value {
        let mut value = serde_json::to_value(object).unwrap_or(serde_json::Value::Null);
        if let Some(meta) = value.get_mut("metadata").and_then(|m| m.as_object_mut()) {
            for noise in [
                "resourceVersion",
                "generation",
                "managedFields",
                "creationTimestamp",
                "uid",
            ] {
                meta.remove(noise);
            }
        }
        value.as_object_mut().map(|o| o.remove("status"));
        value
    }
    comparable(now) == comparable(after)
}

/// Which of the six answers this document gets.
///
/// `same` is decided by the caller from the objects as the server holds
/// them, not from the strings shown here: those have their private keys
/// redacted to one constant, so a rotated `tls.key` compares equal and a
/// Secret whose whole point changed reads as "would not change".
fn classify(
    live: &Live,
    would: &std::result::Result<String, NoAnswer>,
    same: bool,
) -> DryRunOutcome {
    match (live, would) {
        (_, Err(NoAnswer::Refused(said))) => DryRunOutcome::Refused { said: said.clone() },
        (_, Err(NoAnswer::Unanswered(said))) => DryRunOutcome::Unanswered { said: said.clone() },
        (Live::Unread(said), Ok(_)) => DryRunOutcome::LiveUnread { said: said.clone() },
        (Live::Absent, Ok(_)) => DryRunOutcome::Created,
        (Live::Present(_), Ok(_)) if same => DryRunOutcome::Unchanged,
        (Live::Present(_), Ok(_)) => DryRunOutcome::Configured,
    }
}

/// Ask the server what applying this would do, without doing it.
///
/// The same server-side apply as `apply_manifest`, with `dryRun=All`: the
/// apiserver runs admission, fills defaults and answers with the object it
/// would have stored, and stores nothing. What comes back is that object
/// against the one there now, both cleaned the way the editor shows them.
#[tauri::command]
pub async fn dry_run_manifest(
    manifest: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<DryRun> {
    let client = state.current_client()?;
    // One client for the whole manifest, unlike `apply_manifest` which
    // re-reads it per document. The loop here is bounded by the documents
    // in one buffer and two requests each, and a token that expires inside
    // it does not go unnoticed: `session_over` turns the 401 into a failed
    // command, which is what puts the sign-in screen up.
    dry_run_of((*client).clone(), &manifest, namespace.as_deref()).await
}

/// The same answer, for callers that already hold a client — the live
/// harness in `tests/live_dry_run.rs` runs against this.
/// The parameters that make this a preview and not an apply.
///
/// Its own function so a test can hold `dry_run` on it: written inline, the
/// single call that made the difference between showing a change and making
/// one could be deleted with every test in the workspace still green.
fn preview_params() -> PatchParams {
    PatchParams::apply("k8s-gui").force().dry_run()
}

pub async fn dry_run_of(
    client: kube::Client,
    manifest: &str,
    namespace: Option<&str>,
) -> Result<DryRun> {
    let parsed_docs =
        parse_all_documents(manifest).map_err(|e| Error::InvalidInput(e.to_string()))?;
    let patch_params = preview_params();
    let mut documents = Vec::new();

    for parsed in parsed_docs {
        let ns = parsed.effective_namespace(namespace);
        let name = parsed.name();
        let ctx = ResourceContext::from_client(client.clone(), ns.clone());
        let api = ctx.dynamic_api_for_resource(
            &parsed.api_resource,
            is_cluster_scoped(&parsed.api_resource.kind),
        );

        // The objects as the server holds them, kept beside the redacted
        // text: "did anything change" is decided on these, because the text
        // has every private key replaced by one constant and a rotated
        // `tls.key` would compare equal to the old one.
        let (live, live_raw) = live_of(api.get(&name).await)?;
        let (would, would_raw) = would_of(
            api.patch(&name, &patch_params, &Patch::Apply(&parsed.object))
                .await,
        )?;

        let same = match (&live_raw, &would_raw) {
            (Some(now), Some(after)) => unchanged(now, after),
            _ => false,
        };
        let outcome = classify(&live, &would, same);
        documents.push(DryRunDocument {
            id: parsed.format_id(&ns, "").trim_end().to_string(),
            outcome,
            live: match &live {
                Live::Present(yaml) => Some(yaml.clone()),
                Live::Absent | Live::Unread(_) => None,
            },
            would: would.ok(),
        });
    }

    Ok(DryRun { documents })
}

/// Get a resource manifest as YAML
///
/// Fetches any Kubernetes resource by kind, apiVersion, name and namespace.
#[tauri::command]
pub async fn get_manifest(
    kind: String,
    api_version: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_path_segment(&name)?;
    manifest_of(&state, &kind, &api_version, &name, namespace).await
}

async fn manifest_of(
    state: &AppState,
    kind: &str,
    api_version: &str,
    name: &str,
    namespace: Option<String>,
) -> Result<String> {
    // Gateway API kinds are pinned to /v1 by the frontend registry, but a
    // pre-graduation bundle serves them at v1beta1/v1alpha2 — the same
    // negotiation every gateway command does, so the YAML tab matches the
    // Overview it sits beside instead of 404ing. Where discovery gave no
    // version the registry's pin is a guess, and its 404 would read as the
    // object gone.
    let gateway = api_version.starts_with("gateway.networking.k8s.io/");
    let api_resource = if gateway {
        crate::commands::gateway::served_api_resource(kind, state).await?
    } else {
        api_resource_for(kind, api_version)
    };

    let ns = namespace.unwrap_or_else(|| "default".to_string());
    let ctx = ResourceContext::for_command(state, Some(ns))?;
    let api = ctx.dynamic_api_for_resource(&api_resource, is_cluster_scoped(&api_resource.kind));

    let resource = api.get(name).await;
    let resource = if gateway {
        crate::commands::gateway::answered(state, resource)?
    } else {
        resource?
    };

    // Every detail page's YAML tab comes through here, Secrets included, and
    // base64 is not a control: `tls.key` in a manifest is one `base64 -d`
    // from being the key.
    let mut object =
        serde_json::to_value(&resource).map_err(|e| Error::Serialization(e.to_string()))?;
    crate::resources::redact_private_keys(&mut object);

    let yaml = serde_yaml::to_string(&object).map_err(|e| Error::Serialization(e.to_string()))?;

    crate::commands::helpers::clean_yaml_for_editor(&yaml)
}

/// An object's labels and annotations.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMetadata {
    pub labels: std::collections::BTreeMap<String, String>,
    pub annotations: std::collections::BTreeMap<String, String>,
}

/// One object's labels and annotations, for a reader that wants an
/// annotation rather than a manifest to parse for it. A metadata-only read:
/// no spec, and for a Secret no data.
#[tauri::command]
pub async fn get_object_metadata(
    kind: String,
    api_version: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ObjectMetadata> {
    crate::validation::validate_dns_subdomain(&name)?;
    let api_resource = api_resource_for(&kind, &api_version);
    let ns = namespace.unwrap_or_else(|| "default".to_string());
    let ctx = ResourceContext::for_command(&state, Some(ns))?;
    let api = ctx.dynamic_api_for_resource(&api_resource, is_cluster_scoped(&api_resource.kind));
    let meta = api.get_metadata(&name).await?.metadata;
    Ok(ObjectMetadata {
        labels: meta.labels.unwrap_or_default(),
        annotations: meta.annotations.unwrap_or_default(),
    })
}

#[cfg(test)]
mod dry_run_tests {

    /// An expired session is not the cluster rejecting the document.
    ///
    /// A 401 filed with the 4xx refusals blocks Apply as though the YAML
    /// were wrong and prints `CREDENTIALS_EXPIRED: …` — the app's own wire
    /// marker — as the server's words. Both doors out were single `if`
    /// guards inside a loop that only runs against a cluster, so both could
    /// be deleted with the whole Rust suite green.
    #[test]
    fn an_expired_session_leaves_by_its_own_door_on_both_reads() {
        let status = |code: u16, message: &str| {
            kube::Error::Api(Box::new(kube::core::Status {
                code,
                message: message.to_string(),
                reason: message.to_string(),
                status: None,
                details: None,
                metadata: Option::default(),
            }))
        };

        let live = live_of(Err(status(401, "Unauthorized")));
        assert!(
            matches!(live, Err(crate::error::Error::CredentialsExpired(_))),
            "a 401 on the live read is the session, not the document"
        );
        let would = would_of(Err(status(401, "Unauthorized")));
        assert!(
            matches!(would, Err(crate::error::Error::CredentialsExpired(_))),
            "and the same on the dry-run apply"
        );

        // And the refusal that IS about the document still arrives as one.
        let (live, _) = live_of(Err(status(403, "deployments is forbidden")))
            .expect("a 403 is answered, not escaped");
        assert!(matches!(live, Live::Unread(_)));
        let (would, _) =
            would_of(Err(status(422, "Invalid"))).expect("a 422 is answered, not escaped");
        assert!(matches!(would, Err(NoAnswer::Refused(_))));
    }

    /// The one place the third state is actually built, and until now
    /// reachable only through a live cluster: every unit test made `Absent`
    /// and `Unread` by hand, so swapping the two arms changed nothing
    /// anybody ran. They are opposite answers — "there is no such object"
    /// versus "nobody could look" — and the second must not wear the
    /// first's face.
    #[test]
    fn a_404_is_the_object_missing_and_anything_else_is_nobody_looking() {
        let status = |code: u16, message: &str| {
            kube::Error::Api(Box::new(kube::core::Status {
                code,
                message: message.to_string(),
                reason: message.to_string(),
                status: None,
                details: None,
                metadata: Option::default(),
            }))
        };

        assert!(matches!(
            live_failure(status(404, "not found")),
            Live::Absent
        ));
        assert!(matches!(
            live_failure(status(403, "deployments is forbidden")),
            Live::Unread(_)
        ));

        // And the marker never reaches the prose: this string is rendered
        // beside the reader's own language.
        let elapsed: tower::BoxError = Box::new(tower::timeout::error::Elapsed::new());
        match live_failure(kube::Error::Service(elapsed)) {
            Live::Unread(said) => assert!(
                !said.starts_with("READ_DEADLINE:"),
                "a wire marker is not a sentence: {said}"
            ),
            _ => panic!("a timed-out read is unread"),
        }
    }

    /// The equality that decides "would not change" must not be made on the
    /// text the reader sees: `editor_yaml` replaces every private key with
    /// one constant, so a rotated `tls.key` compares equal to the old one
    /// and a Secret whose whole point changed reads as "would not change" —
    /// with no diff drawn, because `Unchanged` suppresses it.
    #[test]
    fn a_rotated_private_key_is_a_change_even_though_both_are_redacted() {
        let secret = |key: &str| {
            let mut object = kube::core::DynamicObject::new(
                "tls",
                &kube::core::ApiResource::erase::<k8s_openapi::api::core::v1::Secret>(&()),
            );
            object.data = serde_json::json!({
                "type": "kubernetes.io/tls",
                "data": { "tls.key": key, "tls.crt": "Y2VydA==" }
            });
            object
        };
        let before = secret("b2xkLWtleQ==");
        let after = secret("bmV3LWtleQ==");

        // What the reader is shown is identical, by design.
        assert_eq!(
            editor_yaml(&before).expect("yaml"),
            editor_yaml(&after).expect("yaml"),
            "the redaction is the point of editor_yaml"
        );
        // And the verdict still has to say it changed.
        assert!(
            !unchanged(&before, &after),
            "a rotated key is a change, whatever the screen shows"
        );
        assert!(unchanged(&before, &secret("b2xkLWtleQ==")));
    }

    /// And the noise the server rewrites on every write is not a change, or
    /// every apply would read as one.
    #[test]
    fn bookkeeping_the_server_rewrites_is_not_a_change() {
        let with_version = |version: &str| {
            let mut object = kube::core::DynamicObject::new(
                "api",
                &kube::core::ApiResource::erase::<k8s_openapi::api::apps::v1::Deployment>(&()),
            );
            object.metadata.resource_version = Some(version.to_string());
            object.data = serde_json::json!({ "spec": { "replicas": 2 } });
            object
        };
        assert!(unchanged(&with_version("1"), &with_version("99")));
    }

    /// A 401 is not the cluster refusing this manifest.
    ///
    /// `no_answer` files everything in 400..500 as `Refused`, which blocks
    /// Apply and prints the error where the server's own words go — so an
    /// expired session read as "the cluster rejected your YAML", with the
    /// `CREDENTIALS_EXPIRED:` wire marker as the explanation. It reaches
    /// every document equally and the app already has one path for it.
    #[test]
    fn an_expired_session_is_not_a_refused_manifest() {
        let status_with = |code: u16, message: &str| kube::core::Status {
            code,
            message: message.to_string(),
            reason: message.to_string(),
            status: None,
            details: None,
            metadata: Option::default(),
        };
        let unauthorised = kube::Error::Api(Box::new(status_with(401, "Unauthorized")));
        assert!(
            super::session_over(&unauthorised),
            "401 has to leave by the door marked sign in again"
        );

        // And the refusals that really are ones, which must still block.
        for code in [403, 409, 422] {
            let refused = kube::Error::Api(Box::new(status_with(code, "denied")));
            assert!(
                !super::session_over(&refused),
                "{code} is about the request"
            );
            assert!(matches!(
                super::no_answer(refused),
                super::NoAnswer::Refused(_)
            ));
        }
    }

    /// The one call that separates showing a change from making one.
    ///
    /// `dry_run_of` runs in no test CI executes — all three callers are
    /// `#[ignore]`d and need a cluster — so deleting `.dry_run()` turned the
    /// preview into a real apply with the whole workspace green. On a
    /// cluster marked critical, that is an apply the reader never confirmed.
    #[test]
    fn the_preview_is_a_preview() {
        let params = super::preview_params();
        assert!(
            params.dry_run,
            "without this the confirmation dialog applies the manifest it is \
             asking about"
        );
        assert!(params.force, "server-side apply takes the field manager");
        assert_eq!(params.field_manager.as_deref(), Some("k8s-gui"));
    }
    use super::*;

    /// The two answers with no current object mean opposite things, and a
    /// dry run that drew a refused read as "would be created" would tell a
    /// person they are about to make something that already exists.
    #[test]
    fn an_unread_object_is_not_one_that_would_be_created() {
        let accepted: std::result::Result<String, NoAnswer> = Ok("kind: Deployment\n".to_string());
        assert_eq!(
            classify(&Live::Absent, &accepted, false),
            DryRunOutcome::Created
        );
        assert_eq!(
            classify(
                &Live::Unread("deployments is forbidden".into()),
                &accepted,
                false
            ),
            DryRunOutcome::LiveUnread {
                said: "deployments is forbidden".into()
            }
        );
    }

    /// A 502 from a proxy is not the server saying no, and drawing it as a
    /// refusal would block an apply the server never saw. Only a 4xx with a
    /// `Status` is the server's own answer.
    #[test]
    fn a_gateway_that_never_answered_is_not_a_refusal() {
        let status = |code: u16, reason: &str| {
            kube::Error::Api(
                kube::core::Status {
                    code,
                    reason: reason.into(),
                    message: "nope".into(),
                    ..Default::default()
                }
                .boxed(),
            )
        };
        assert!(matches!(
            no_answer(status(422, "Invalid")),
            NoAnswer::Refused(_)
        ));
        assert!(matches!(
            no_answer(status(403, "Forbidden")),
            NoAnswer::Refused(_)
        ));
        assert!(matches!(
            no_answer(status(502, "Failed to parse error data")),
            NoAnswer::Unanswered(_)
        ));
        assert!(matches!(
            no_answer(kube::Error::Service("connection reset".into())),
            NoAnswer::Unanswered(_)
        ));
    }

    #[test]
    fn the_same_object_back_is_no_change_and_a_different_one_is_a_change() {
        let now = Live::Present("spec:\n  replicas: 2\n".to_string());
        assert_eq!(
            classify(&now, &Ok("spec:\n  replicas: 2\n".to_string()), true),
            DryRunOutcome::Unchanged
        );
        assert_eq!(
            classify(&now, &Ok("spec:\n  replicas: 4\n".to_string()), false),
            DryRunOutcome::Configured
        );
    }

    /// A refusal is the server's answer, whatever is there now: the real
    /// apply would be refused the same way, and nothing is worth diffing.
    #[test]
    fn a_refusal_wins_over_whatever_is_there() {
        let refused = Err(NoAnswer::Refused("admission webhook denied it".to_string()));
        for live in [
            Live::Present("x".into()),
            Live::Absent,
            Live::Unread("forbidden".into()),
        ] {
            assert_eq!(
                classify(&live, &refused, false),
                DryRunOutcome::Refused {
                    said: "admission webhook denied it".into()
                }
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::client::served::test_server::{connected, failure, groups, resources};
    use crate::client::served::ServedIndex;

    /// Would keep the YAML tab of a route read at a version the cluster
    /// stopped serving on "not found" until discovery aged out, while the
    /// Overview beside it recovered on its next poll: its get was the one
    /// request on a Gateway API kind no test went through.
    #[tokio::test]
    async fn a_404_on_a_gateway_kind_sends_discovery_back() {
        let served = ServedIndex::aged(
            Duration::from_mins(1),
            Duration::from_mins(2),
            Duration::from_millis(100),
        );
        let (state, hits) = connected(served, |path, _| match path {
            "/apis" => (200, groups("v1", &["v1"])),
            "/apis/gateway.networking.k8s.io/v1" => {
                (200, resources("v1", &[("httproutes", "HTTPRoute", true)]))
            }
            _ => failure(404, "NotFound"),
        })
        .await;
        let asked = || hits.lock().unwrap().get("/apis").copied();
        let yaml = || {
            super::manifest_of(
                &state,
                "HTTPRoute",
                "gateway.networking.k8s.io/v1",
                "gone",
                Some("default".to_string()),
            )
        };

        assert!(yaml().await.is_err());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(yaml().await.is_err());
        assert_eq!(asked(), Some(1));
        assert!(yaml().await.is_err());
        assert_eq!(asked(), Some(2), "the YAML tab's 404 sent discovery back");
    }

    /// Would ask for a route at the registry's `v1`, which a pre-graduation
    /// bundle does not serve, whenever discovery failed, and hand the reader
    /// that version's 404 in place of the failure that actually happened.
    #[tokio::test]
    async fn a_gateway_kind_is_not_read_at_a_version_discovery_never_gave() {
        let (state, hits) = connected(ServedIndex::default(), |path, _| match path {
            "/apis" => failure(503, "ServiceUnavailable"),
            _ => failure(404, "NotFound"),
        })
        .await;

        let answer = super::manifest_of(
            &state,
            "TCPRoute",
            "gateway.networking.k8s.io/v1",
            "db",
            Some("default".to_string()),
        )
        .await;

        let guessed = "/apis/gateway.networking.k8s.io/v1/namespaces/default/tcproutes/db";
        assert_eq!(hits.lock().unwrap().get(guessed), None, "asked at a guess");
        match answer {
            Err(crate::error::Error::KubeApi(kube::Error::Api(status))) => {
                assert_eq!(status.code, 503, "the discovery failure, not a 404");
            }
            other => panic!("the discovery failure, not {other:?}"),
        }
    }
}
