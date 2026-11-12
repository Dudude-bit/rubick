//! Tauri commands for manifest validate / apply / delete / get.

use crate::commands::helpers::{editor_yaml, ResourceContext};
use crate::error::{Error, Result};
use crate::state::AppState;
use kube::api::{Patch, PatchParams};
use tauri::State;

use super::parse::{api_resource_for, is_cluster_scoped, parse_all_documents};
use super::{
    Applied, AppliedDocument, ApplyOutcome, DryRun, DryRunDocument, DryRunOutcome, ManifestResult,
};

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
) -> Result<Applied> {
    apply_of(&state, &manifest, namespace.as_deref()).await
}

/// Every document in turn, stopping at the first that did not go in: the
/// ones before it are stored, and the answer has to say so.
async fn apply_of(state: &AppState, manifest: &str, namespace: Option<&str>) -> Result<Applied> {
    let parsed_docs = parse_all_documents(manifest)?;
    let patch_params = PatchParams::apply("k8s-gui").force();
    let mut documents = Vec::new();
    let mut stopped = false;

    for parsed in parsed_docs {
        let ns = parsed.effective_namespace(namespace);
        let outcome = if stopped {
            ApplyOutcome::NotSent
        } else {
            let sent = async {
                let ctx = ResourceContext::for_command(state, Some(ns.clone()))?;
                let api = ctx.dynamic_api_for_resource(
                    &parsed.api_resource,
                    is_cluster_scoped(&parsed.api_resource.kind),
                );
                let patch = Patch::Apply(&parsed.object);
                applied_of(api.patch(&parsed.name(), &patch_params, &patch).await)
            };
            match sent.await {
                Ok(outcome) => outcome,
                Err(error) => cut_short(error, documents.len())?,
            }
        };
        stopped = outcome != ApplyOutcome::Applied;
        documents.push(AppliedDocument {
            id: parsed.format_id(&ns, "").trim_end().to_string(),
            outcome,
        });
    }

    Ok(Applied { documents })
}

/// The answer for a document the command itself failed on: the session
/// ended, or the window left its cluster. With nothing stored yet that is
/// the command's own failure, by the door the sign-in screen listens at.
/// After `stored` documents went in it is this document's answer instead: a
/// failed command lists nothing, and the reader would apply them again.
fn cut_short(error: Error, stored: usize) -> Result<ApplyOutcome> {
    if stored == 0 {
        return Err(error);
    }
    Ok(ApplyOutcome::Refused {
        code: error.code().to_string(),
        said: shown(&error),
    })
}

/// How one document's apply ended.
///
/// The arms are the point. A 4xx is the server's own no and nothing was
/// stored. A deadline, a 5xx or a dropped connection is nobody answering a
/// request that left: admission can outlast the wait, and "failed" there is
/// a verdict on something nobody saw. A 401 is the session, and leaves by
/// the door the sign-in screen listens at.
fn applied_of<T>(patched: std::result::Result<T, kube::Error>) -> Result<ApplyOutcome> {
    let (refused, error) = match patched {
        Ok(_) => return Ok(ApplyOutcome::Applied),
        Err(e) if session_over(&e) => return Err(Error::from(e)),
        Err(e) => answered_no(e),
    };
    let said = shown(&error);
    Ok(if refused {
        ApplyOutcome::Refused {
            code: error.code().to_string(),
            said,
        }
    } else {
        ApplyOutcome::Unanswered { said }
    })
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
        other => Live::Unread(shown(&Error::from(other))),
    }
}

/// An error as a sentence for the screen, beside the reader's own language.
///
/// The marker is a wire format, not prose: `READ_DEADLINE: …` there is the
/// app's plumbing on screen, and so is the variant's own label.
fn shown(error: &Error) -> String {
    let said = error.said();
    let markers = ["READ_DEADLINE: ", "CREDENTIALS_EXPIRED: "];
    let prose = markers.iter().find_map(|marker| said.strip_prefix(marker));
    prose.unwrap_or(&said).to_string()
}

/// A 401 is the session being over, not the server refusing this manifest.
///
/// It reaches every document and every other command equally, the app has
/// one path for it, and that path starts with the command failing so the
/// wrapper can see the `CREDENTIALS_EXPIRED:` marker. Classified as a
/// refusal it blocked Apply — a sign-in problem dressed as the cluster
/// rejecting the reader's YAML — and put the wire marker on screen as prose.
fn session_over(err: &kube::Error) -> bool {
    crate::error::session_over(err).is_some()
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
    let (refused, error) = answered_no(err);
    if refused {
        NoAnswer::Refused(shown(&error))
    } else {
        NoAnswer::Unanswered(shown(&error))
    }
}

/// Whether the server itself said no, and the error it said it with. Only a
/// 4xx with a `Status` is its own answer; a deadline or a proxy's 502 is not.
fn answered_no(err: kube::Error) -> (bool, Error) {
    let error = Error::from(err);
    (!error.is_unanswered(), error)
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
    let parsed_docs = parse_all_documents(manifest)?;
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
    crate::client::clock::timed(
        &state.perf,
        "getManifest",
        manifest_of(&state, &kind, &api_version, &name, namespace),
    )
    .await
}

/// Where one object is read, for every reader of one by kind and version.
struct Served {
    api: kube::Api<kube::api::DynamicObject>,
    gateway: bool,
}

impl Served {
    // Gateway API kinds are pinned to /v1 by the frontend registry, but a
    // pre-graduation bundle serves them at v1beta1/v1alpha2 — the same
    // negotiation every gateway command does, so the YAML tab matches the
    // Overview it sits beside instead of 404ing. Where discovery gave no
    // version the registry's pin is a guess, and its 404 would read as the
    // object gone.
    async fn at(
        state: &AppState,
        kind: &str,
        api_version: &str,
        namespace: Option<String>,
    ) -> Result<Self> {
        let gateway = api_version.starts_with("gateway.networking.k8s.io/");
        let api_resource = if gateway {
            crate::commands::gateway::served_api_resource(kind, state).await?
        } else {
            api_resource_for(kind, api_version)
        };
        let ns = namespace.unwrap_or_else(|| "default".to_string());
        let ctx = ResourceContext::for_command(state, Some(ns))?;
        let api =
            ctx.dynamic_api_for_resource(&api_resource, is_cluster_scoped(&api_resource.kind));
        Ok(Self { api, gateway })
    }

    fn answered<T>(&self, state: &AppState, answer: kube::Result<T>) -> Result<T> {
        if self.gateway {
            crate::commands::gateway::answered(state, answer)
        } else {
            Ok(answer?)
        }
    }
}

async fn manifest_of(
    state: &AppState,
    kind: &str,
    api_version: &str,
    name: &str,
    namespace: Option<String>,
) -> Result<String> {
    let served = Served::at(state, kind, api_version, namespace).await?;
    let resource = served.answered(state, served.api.get(name).await)?;

    // Every detail page's YAML tab comes through here, Secrets included, and
    // base64 is not a control: `tls.key` in a manifest is one `base64 -d`
    // from being the key.
    editor_yaml(&resource)
}

/// An object's uid, labels and annotations.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMetadata {
    pub uid: Option<String>,
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
    crate::client::clock::timed(&state.perf, "getObjectMetadata", async {
        let served = Served::at(&state, &kind, &api_version, namespace).await?;
        let meta = served
            .answered(&state, served.api.get_metadata(&name).await)?
            .metadata;
        Ok(ObjectMetadata {
            annotations: crate::resources::annotations_of(&meta),
            uid: meta.uid,
            labels: meta.labels.unwrap_or_default(),
        })
    })
    .await
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

    /// Both sides of the preview are drawn, and Copy takes them: the object
    /// there now and the one the server would store each carry the record
    /// `kubectl apply` keeps, and with it the key in full.
    #[test]
    fn neither_side_of_the_preview_carries_the_key_kubectl_recorded() {
        const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");
        let applied = serde_json::json!({ "kind": "ConfigMap", "data": { "server.key": KEY } });
        let config = || {
            let mut object = kube::core::DynamicObject::new(
                "nginx",
                &kube::core::ApiResource::erase::<k8s_openapi::api::core::v1::ConfigMap>(&()),
            );
            object.metadata.annotations = Some(
                [(
                    "kubectl.kubernetes.io/last-applied-configuration".to_string(),
                    applied.to_string(),
                )]
                .into(),
            );
            object.data = serde_json::json!({ "data": { "server.key": KEY } });
            object
        };

        let (live, _) = live_of(Ok(config())).expect("read");
        let (would, _) = would_of(Ok(config())).expect("answered");
        let Live::Present(live) = live else {
            panic!("the object is there")
        };
        let would = would.ok().expect("the server answered with an object");
        for yaml in [live, would] {
            assert!(yaml.contains("server.key"), "{yaml}");
            assert!(!yaml.contains("PRIVATE KEY"), "{yaml}");
        }
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

    use super::super::ApplyOutcome;
    use crate::client::served::test_server::{connected, failure, groups, resources};
    use crate::client::served::ServedIndex;
    use crate::error::Error;

    fn status(code: u16, reason: &str, message: &str) -> kube::Error {
        kube::Error::Api(Box::new(kube::core::Status {
            code,
            message: message.to_string(),
            reason: reason.to_string(),
            status: None,
            details: None,
            metadata: Option::default(),
        }))
    }

    /// Every failed patch used to come back as one "Failed to apply" result,
    /// so a PATCH the admission chain held past the read deadline was drawn
    /// as a failed apply the server may well have stored. A deadline, a 5xx
    /// and a dropped connection are nobody answering; only a 4xx is a no.
    #[test]
    fn an_apply_nobody_answered_is_not_one_the_server_refused() {
        let elapsed: tower::BoxError = Box::new(tower::timeout::error::Elapsed::new());
        match super::applied_of::<()>(Err(kube::Error::Service(elapsed))) {
            Ok(ApplyOutcome::Unanswered { said }) => {
                assert!(said.contains("did not answer within"), "{said}");
                assert!(!said.contains("READ_DEADLINE"), "a wire marker: {said}");
            }
            other => panic!("a deadline is nobody answering, not {other:?}"),
        }
        for unanswered in [
            status(502, "BadGateway", "bad gateway"),
            status(504, "Timeout", "request did not complete"),
            kube::Error::Service("connection reset".into()),
        ] {
            assert!(matches!(
                super::applied_of::<()>(Err(unanswered)),
                Ok(ApplyOutcome::Unanswered { .. })
            ));
        }

        assert_eq!(
            super::applied_of::<()>(Err(status(422, "Invalid", "replicas: must be >= 0")))
                .expect("answered"),
            ApplyOutcome::Refused {
                code: "KUBE_API_ERROR".into(),
                said: "replicas: must be >= 0".into(),
            }
        );
        assert_eq!(
            super::applied_of(Ok(())).expect("answered"),
            ApplyOutcome::Applied
        );
    }

    /// The frontend learns a 403 on the patch from the code, and remembers
    /// the refusal by it; some distributions send `Forbidden` with the code
    /// unset, and that is still the server's no and not silence.
    #[test]
    fn a_forbidden_apply_is_refused_with_its_code_however_it_is_filed() {
        for forbidden in [
            status(403, "Forbidden", "configmaps is forbidden"),
            status(0, "Forbidden", "configmaps is forbidden"),
        ] {
            assert_eq!(
                super::applied_of::<()>(Err(forbidden)).expect("answered"),
                ApplyOutcome::Refused {
                    code: "PERMISSION_DENIED".into(),
                    said: "configmaps is forbidden".into(),
                }
            );
        }
    }

    /// A 401 on the patch was folded into the "failed" result, so the
    /// command never failed, the wrapper never saw `CREDENTIALS_EXPIRED`
    /// and no sign-in was offered for an apply the session had outlived.
    #[test]
    fn an_expired_session_fails_the_apply_instead_of_answering_it() {
        for unauthorised in [
            status(401, "Unauthorized", "Unauthorized"),
            status(0, "Unauthorized", "Unauthorized"),
        ] {
            assert!(matches!(
                super::applied_of::<()>(Err(unauthorised)),
                Err(Error::CredentialsExpired(_))
            ));
        }
    }

    /// A dry run past the deadline printed the wire marker as the server's
    /// words, and with it lost the sentence that says how long was waited.
    #[test]
    fn a_dry_run_past_the_deadline_says_so_in_a_sentence() {
        let elapsed: tower::BoxError = Box::new(tower::timeout::error::Elapsed::new());
        match super::no_answer(kube::Error::Service(elapsed)) {
            super::NoAnswer::Unanswered(said) => {
                assert!(
                    said.starts_with("the cluster did not answer within"),
                    "{said}"
                );
            }
            super::NoAnswer::Refused(said) => panic!("a deadline is not a no: {said}"),
        }
    }

    /// Three documents, the second refused: the early return dropped the
    /// first one's result, so nothing said it was already stored, and the
    /// third's fate went unstated. Fails if the first is not reported as
    /// applied, or the third is sent or left out.
    #[tokio::test]
    async fn a_refused_document_leaves_the_ones_before_it_applied_and_the_rest_unsent() {
        let config = |name: &str| {
            format!("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {name}\n---\n")
        };
        let path = |name: &str| format!("/api/v1/namespaces/shop/configmaps/{name}");
        let (state, hits) = connected(ServedIndex::default(), |path, _| {
            if path.ends_with("/configmaps/b") {
                failure(403, "Forbidden")
            } else {
                let stored = r#"{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"x"}}"#;
                (200, stored.to_string())
            }
        })
        .await;

        let manifest = ["a", "b", "c"].map(config).concat();
        let applied = super::apply_of(&state, &manifest, Some("shop"))
            .await
            .expect("the run is answered, document by document");

        let ids: Vec<&str> = applied.documents.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            ids,
            ["configmap/shop a", "configmap/shop b", "configmap/shop c"]
        );
        assert_eq!(applied.documents[0].outcome, ApplyOutcome::Applied);
        assert!(matches!(
            &applied.documents[1].outcome,
            ApplyOutcome::Refused { code, .. } if code == "PERMISSION_DENIED"
        ));
        assert_eq!(applied.documents[2].outcome, ApplyOutcome::NotSent);
        let asked = hits.lock().unwrap();
        assert_eq!(asked.get(&path("a")), Some(&1));
        assert_eq!(asked.get(&path("c")), None, "sent after the refusal");
    }

    /// The YAML tab of every kind with a page of its own, the peek's YAML and
    /// the editor's buffer are this read. Found on a `ConfigMap` made with
    /// `kubectl apply`: the key withheld under `data`, and whole three lines
    /// lower in the annotation.
    #[tokio::test]
    async fn the_manifest_of_an_applied_configmap_carries_the_key_nowhere() {
        const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");
        let applied = serde_json::json!({ "kind": "ConfigMap", "data": { "server.key": KEY } });
        let stored = serde_json::json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {
                "name": "nginx",
                "namespace": "team-a",
                "annotations": {
                    "kubectl.kubernetes.io/last-applied-configuration": applied.to_string(),
                },
            },
            "data": { "nginx.conf": "worker_processes 2;", "server.key": KEY },
        })
        .to_string();
        let (state, _) = connected(ServedIndex::default(), move |path, _| match path {
            "/api/v1/namespaces/team-a/configmaps/nginx" => (200, stored.clone()),
            _ => failure(404, "NotFound"),
        })
        .await;

        let yaml = super::manifest_of(&state, "ConfigMap", "v1", "nginx", Some("team-a".into()))
            .await
            .expect("read");
        assert!(yaml.contains("nginx.conf: worker_processes 2;"), "{yaml}");
        assert!(yaml.contains("last-applied-configuration"), "{yaml}");
        assert!(!yaml.contains("PRIVATE KEY"), "{yaml}");
    }

    const TWO_CONFIGMAPS: &str = "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\n\
        apiVersion: v1\nkind: ConfigMap\nmetadata: {name: b}\n---\n\
        apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\n";

    /// A token that ran out between two documents failed the whole command:
    /// the editor said "Apply failed" and listed nothing, with the first
    /// document stored. Fails if the documents that went in are not listed
    /// beside the one the session ended on, or the rest are still sent.
    #[tokio::test]
    async fn an_apply_cut_by_the_session_ending_says_which_documents_went_in() {
        let (state, hits) = connected(ServedIndex::default(), |path, _| match path {
            "/api/v1/namespaces/shop/configmaps/a" => (
                200,
                r#"{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"a"}}"#.to_string(),
            ),
            _ => failure(401, "Unauthorized"),
        })
        .await;

        let applied = super::apply_of(&state, TWO_CONFIGMAPS, Some("shop"))
            .await
            .expect("an answer per document");

        let said: Vec<(&str, &ApplyOutcome)> = applied
            .documents
            .iter()
            .map(|doc| (doc.id.as_str(), &doc.outcome))
            .collect();
        assert_eq!(said[0], ("configmap/shop a", &ApplyOutcome::Applied));
        assert_eq!(said[1].0, "configmap/shop b");
        match said[1].1 {
            ApplyOutcome::Refused { code, said } => {
                assert_eq!(code, "CREDENTIALS_EXPIRED");
                assert!(
                    !said.contains("CREDENTIALS_EXPIRED"),
                    "a wire marker: {said}"
                );
            }
            other => panic!("the session ended on it: {other:?}"),
        }
        assert_eq!(said[2], ("configmap/shop c", &ApplyOutcome::NotSent));
        let sent = |name: &str| {
            let path = format!("/api/v1/namespaces/shop/configmaps/{name}");
            hits.lock().unwrap().get(path.as_str()).copied()
        };
        assert_eq!((sent("b"), sent("c")), (Some(1), None));
    }

    /// The cost of the one above: with nothing stored, the session ending
    /// is still the command failing, which is what puts the sign-in screen up.
    #[tokio::test]
    async fn an_apply_the_session_ended_before_fails_as_the_session_ending() {
        let (state, _) =
            connected(ServedIndex::default(), |_, _| failure(401, "Unauthorized")).await;

        let failed = super::apply_of(&state, TWO_CONFIGMAPS, Some("shop")).await;

        assert!(
            matches!(failed, Err(Error::CredentialsExpired(_))),
            "{failed:?}"
        );
    }

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
