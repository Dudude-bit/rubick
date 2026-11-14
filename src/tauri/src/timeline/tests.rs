use serde_json::{json, Value};

use super::project::{changed, digest, followed, moves, snapshot, Snapshot, ROW_FIELDS};
use super::spans::{HEARTBEAT_MISSED_MS, HEARTBEAT_MS};
use super::store::{Store, MAX_CHANGES, MAX_NORMAL, PAGE_BYTES, PAGE_ROWS};
use super::*;

const T0: i64 = 1_800_000_000_000;

fn snap(kind: &str, group: &str, object: &Value) -> Snapshot {
    snapshot(followed(kind, group).expect("followed"), object)
}

fn deployment(image: &str, replicas: i64, env: &str) -> Value {
    json!({
        "metadata": {
            "name": "api", "namespace": "shop", "generation": replicas,
            "creationTimestamp": "2026-11-01T00:00:00Z",
            "labels": {"app": "api"},
            "annotations": {"deployment.kubernetes.io/revision": "3"}
        },
        "spec": {
            "replicas": replicas,
            "template": {"spec": {"containers": [
                {"name": "api", "image": image,
                 "env": [
                    {"name": "DB_PASSWORD", "value": env},
                    {"name": "DB_HOST", "valueFrom": {"configMapKeyRef": {"name": "db", "key": "host"}}}
                 ],
                 "resources": {"requests": {"cpu": "100m"}},
                 "readinessProbe": {"httpGet": {"path": "/ready", "port": 8080}}},
                {"name": "sidecar", "image": "envoy:1"}
            ]}}
        }
    })
}

fn moved(path: &str, from: Option<&str>, to: Option<&str>) -> FieldMove {
    FieldMove::Moved {
        path: path.to_string(),
        from: from.map(str::to_string),
        to: to.map(str::to_string),
    }
}

/// The headline of a rollout: fails if the image is not said in the
/// container's own path, or the replicas beside it.
#[test]
fn a_new_image_and_a_scale_are_said_in_the_objects_own_paths() {
    let before = snap("Deployment", "apps", &deployment("nginx:1.27", 2, "s3cret"));
    let after = snap("Deployment", "apps", &deployment("nginx:1.28", 3, "s3cret"));
    let found = moves(&before, &after);
    assert!(found.contains(&moved(
        "spec.template.spec.containers[api].image",
        Some("nginx:1.27"),
        Some("nginx:1.28")
    )));
    assert!(found.contains(&moved("spec.replicas", Some("2"), Some("3"))));
    assert_eq!(found.len(), 2, "{found:?}");
}

/// A container list read in another order is the same template. Fails if
/// containers are compared by position.
#[test]
fn containers_reordered_are_no_change() {
    let mut other = deployment("nginx:1.27", 2, "s3cret");
    other["spec"]["template"]["spec"]["containers"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let before = snap("Deployment", "apps", &deployment("nginx:1.27", 2, "s3cret"));
    assert!(moves(&before, &snap("Deployment", "apps", &other)).is_empty());
}

/// An env literal may be a password. Fails if its value reaches a row, or
/// if the change to it goes unsaid.
#[test]
fn an_env_literal_is_named_and_its_value_is_not_kept() {
    let before = snap(
        "Deployment",
        "apps",
        &deployment("nginx:1", 2, "first-value"),
    );
    let after = snap(
        "Deployment",
        "apps",
        &deployment("nginx:1", 2, "second-value"),
    );
    let said = changed(&before, &after).expect("a change");
    let RowSays::Changed { fields, .. } = &said else {
        panic!("{said:?}")
    };
    assert_eq!(
        fields,
        &[FieldMove::NotKept {
            path: "spec.template.spec.containers[api].env[DB_PASSWORD].value".into(),
            was: true,
            is: true,
        }]
    );
    let wire = serde_json::to_string(&said).unwrap();
    assert!(!wire.contains("first-value") && !wire.contains("second-value"));
}

/// Where an env var is set from is a reference, not a secret. Fails if a
/// moved reference is withheld like a literal.
#[test]
fn an_env_reference_is_kept() {
    let mut other = deployment("nginx:1", 2, "v");
    other["spec"]["template"]["spec"]["containers"][0]["env"][1]["valueFrom"]["configMapKeyRef"]
        ["key"] = json!("address");
    let found = moves(
        &snap("Deployment", "apps", &deployment("nginx:1", 2, "v")),
        &snap("Deployment", "apps", &other),
    );
    assert_eq!(
        found,
        [moved(
            "spec.template.spec.containers[api].env[DB_HOST].valueFrom.configMapKeyRef.key",
            Some("host"),
            Some("address")
        )]
    );
}

fn config_map(data: &Value) -> Value {
    json!({"metadata": {"name": "app", "namespace": "shop"}, "data": data})
}

/// A `ConfigMap` or `Secret` change says which keys moved and never what they
/// hold. Fails if a value reaches the row, or a changed, added or removed key
/// goes unsaid.
#[test]
fn a_config_map_and_a_secret_say_keys_and_never_values() {
    let before = snap(
        "ConfigMap",
        "",
        &config_map(&json!({"a": "one", "b": "two", "old": "x"})),
    );
    let after = snap(
        "ConfigMap",
        "",
        &config_map(&json!({"a": "one", "b": "TWO", "new": "y"})),
    );
    let not_kept = |path: &str, was, is| FieldMove::NotKept {
        path: path.into(),
        was,
        is,
    };
    assert_eq!(
        moves(&before, &after),
        [
            not_kept("data.b", true, true),
            not_kept("data.new", false, true),
            not_kept("data.old", true, false)
        ]
    );
    let secret = |value: &str| {
        json!({"metadata": {"name": "db", "namespace": "shop"}, "type": "Opaque",
               "data": {"password": value}})
    };
    let said = changed(
        &snap("Secret", "", &secret("aHVudGVyMg==")),
        &snap("Secret", "", &secret("c3dvcmRmaXNo")),
    )
    .expect("a change");
    let wire = serde_json::to_string(&said).unwrap();
    assert!(wire.contains("data.password"), "{wire}");
    assert!(!wire.contains("aHVudGVyMg==") && !wire.contains("c3dvcmRmaXNo"));
}

/// The annotation `kubectl apply` leaves holds the whole object, a Secret's
/// values with it. Fails if a change to it is a row.
#[test]
fn the_last_applied_annotation_is_never_diffed() {
    let with = |applied: &str| {
        json!({"metadata": {"name": "db", "namespace": "shop",
            "annotations": {"kubectl.kubernetes.io/last-applied-configuration": applied}},
            "type": "Opaque", "data": {}})
    };
    let before = snap(
        "Secret",
        "",
        &with(r#"{"data":{"password":"aHVudGVyMg=="}}"#),
    );
    let after = snap(
        "Secret",
        "",
        &with(r#"{"data":{"password":"c3dvcmRmaXNo"}}"#),
    );
    assert!(changed(&before, &after).is_none());
}

/// A private key never reaches the screen, whatever field carries it.
/// Fails if a kept value skips the one door.
#[test]
fn a_private_key_in_a_kept_field_is_withheld() {
    let key = [
        "-----BEGIN ",
        "PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\n-----END ",
        "PRIVATE KEY-----",
    ]
    .concat();
    let with = |note: &str| {
        json!({"metadata": {"name": "api", "namespace": "shop"},
               "spec": {"type": "ClusterIP", "loadBalancerClass": note}})
    };
    let said = changed(
        &snap("Service", "", &with("plain")),
        &snap("Service", "", &with(&key)),
    )
    .expect("a change");
    let wire = serde_json::to_string(&said).unwrap();
    assert!(!wire.contains("MIIBVQIBADANBgkqhkiG9w0BAQEFAASC"), "{wire}");
    assert!(wire.contains(crate::resources::WITHHELD_MARKER), "{wire}");
}

fn node(unschedulable: bool, ready: &str, heartbeat: &str) -> Value {
    json!({"metadata": {"name": "worker"},
           "spec": if unschedulable { json!({"unschedulable": true}) } else { json!({"podCIDR": "10.0.0.0/24"}) },
           "status": {"conditions": [{"type": "Ready", "status": ready,
               "lastHeartbeatTime": heartbeat, "reason": "KubeletReady"}]}})
}

/// A cordon and a node going not-ready are changes; the kubelet's heartbeat
/// is not. Fails if heartbeat times are compared, or a condition's status is not.
#[test]
fn a_cordon_and_a_condition_are_changes_and_a_heartbeat_is_not() {
    let base = snap("Node", "", &node(false, "True", "10:00"));
    assert!(moves(&base, &snap("Node", "", &node(false, "True", "10:01"))).is_empty());
    let found = moves(&base, &snap("Node", "", &node(true, "Unknown", "10:02")));
    assert_eq!(
        found,
        [
            moved("spec.podCIDR", Some("10.0.0.0/24"), None),
            moved("spec.unschedulable", None, Some("true")),
            moved(
                "status.conditions[Ready].status",
                Some("True"),
                Some("Unknown")
            )
        ]
    );
}

/// A volume grown is said where the claim asked and where it was given.
#[test]
fn a_claim_resized_says_the_request_and_the_capacity() {
    let pvc = |asked: &str, given: &str| {
        json!({"metadata": {"name": "data", "namespace": "shop"},
               "spec": {"resources": {"requests": {"storage": asked}}},
               "status": {"phase": "Bound", "capacity": {"storage": given}}})
    };
    let found = moves(
        &snap("PersistentVolumeClaim", "", &pvc("1Gi", "1Gi")),
        &snap("PersistentVolumeClaim", "", &pvc("2Gi", "2Gi")),
    );
    assert_eq!(
        found,
        [
            moved("spec.resources.requests.storage", Some("1Gi"), Some("2Gi")),
            moved("status.capacity.storage", Some("1Gi"), Some("2Gi"))
        ]
    );
}

/// A label whose key is not a plain word is bracketed, as kubectl's
/// jsonpath would need it. Fails if the key is split at its dots.
#[test]
fn a_namespace_label_is_said_under_its_whole_key() {
    let ns = |level: &str| {
        json!({"metadata": {"name": "shop",
            "labels": {"pod-security.kubernetes.io/enforce": level}}})
    };
    assert_eq!(
        moves(
            &snap("Namespace", "", &ns("baseline")),
            &snap("Namespace", "", &ns("restricted"))
        ),
        [moved(
            "metadata.labels[pod-security.kubernetes.io/enforce]",
            Some("baseline"),
            Some("restricted")
        )]
    );
}

/// "Roll back to before this" needs the revision before a template change.
/// Fails if a scale names one, or a rollout does not.
#[test]
fn a_template_change_names_the_revision_before_it_and_a_scale_does_not() {
    let before = snap("Deployment", "apps", &deployment("nginx:1", 2, "v"));
    let named = |after: &Snapshot, before: &Snapshot| match changed(before, after) {
        Some(RowSays::Changed { before, .. }) => before,
        other => panic!("{other:?}"),
    };
    let rolled = snap("Deployment", "apps", &deployment("nginx:2", 2, "v"));
    assert_eq!(named(&rolled, &before).as_deref(), Some("3"));
    let scaled = snap("Deployment", "apps", &deployment("nginx:1", 5, "v"));
    assert_eq!(named(&scaled, &before), None);
    let set = |image: &str| {
        json!({"metadata": {"name": "db", "namespace": "shop"},
               "spec": {"template": {"spec": {"containers": [{"name": "db", "image": image}]}}},
               "status": {"updateRevision": "db-7c9"}})
    };
    let pg16 = snap("StatefulSet", "apps", &set("pg:16"));
    let pg17 = snap("StatefulSet", "apps", &set("pg:17"));
    assert_eq!(named(&pg17, &pg16).as_deref(), Some("db-7c9"));
}

/// A row past its fields counts the rest instead of growing without end.
#[test]
fn a_row_names_at_most_its_share_of_fields_and_counts_the_rest() {
    let labels = |value: &str| {
        let map: serde_json::Map<String, Value> =
            (0..50).map(|n| (format!("l{n}"), json!(value))).collect();
        json!({"metadata": {"name": "app", "namespace": "shop", "labels": map}, "data": {}})
    };
    match changed(
        &snap("ConfigMap", "", &labels("a")),
        &snap("ConfigMap", "", &labels("b")),
    ) {
        Some(RowSays::Changed { fields, more, .. }) => {
            assert_eq!((fields.len(), more), (ROW_FIELDS, 50 - ROW_FIELDS));
        }
        other => panic!("{other:?}"),
    }
}

fn change(id: &str, at: i64, kind: &str, namespace: Option<&str>, name: &str) -> TimelineRow {
    TimelineRow {
        id: id.into(),
        seq: 0,
        at,
        kind: kind.into(),
        group: String::new(),
        namespace: namespace.map(str::to_string),
        name: name.into(),
        what: RowSays::Created,
        at_relist: false,
    }
}

fn event(uid: &str, type_: &str, count: i32, last: i64) -> EventInfo {
    let moment = chrono::DateTime::from_timestamp_millis(last).unwrap();
    EventInfo {
        name: format!("{uid}.1"),
        namespace: "shop".into(),
        uid: uid.into(),
        type_: type_.into(),
        reason: Some("BackOff".into()),
        message: Some("Back-off restarting failed container".into()),
        source: Some("kubelet".into()),
        involved_object: crate::resources::InvolvedObjectInfo {
            api_version: Some("v1".into()),
            kind: "Pod".into(),
            name: "api-7c9".into(),
            namespace: Some("shop".into()),
            uid: Some("pod-1".into()),
        },
        count: Some(count),
        first_timestamp: Some(moment),
        last_timestamp: Some(moment),
    }
}

fn query(show: Show) -> TimelineQuery {
    TimelineQuery {
        context: "kind".into(),
        subject: None,
        scope: None,
        from: 0,
        show,
        after: None,
        before: None,
    }
}

fn holder(
    root: Option<std::path::PathBuf>,
    keep: bool,
) -> (Arc<Timelines>, broadcast::Receiver<AppEvent>) {
    let (tx, rx) = broadcast::channel(64);
    (Arc::new(Timelines::new(root, keep, tx)), rx)
}

fn series_row(event: EventInfo) -> TimelineRow {
    let at = event.last_timestamp.unwrap().timestamp_millis();
    TimelineRow {
        id: event.uid.clone(),
        seq: 0,
        at,
        kind: "Pod".into(),
        group: String::new(),
        namespace: Some("shop".into()),
        name: "api-7c9".into(),
        what: RowSays::Event {
            event: Box::new(event),
        },
        at_relist: false,
    }
}

/// A repeat is the series' latest, not another row. Fails if each repeat
/// adds a row, or the repeat keeps its old place for a reader of `after`.
#[test]
fn a_series_repeat_replaces_its_row_and_is_newer_for_a_reader_of_after() {
    let mut store = Store::default();
    store.record(series_row(event("e1", "Warning", 1, T0)), T0);
    store.record(change("c1", T0 + 10, "Deployment", Some("shop"), "api"), T0);
    let seen = store.newest();
    store.record(series_row(event("e1", "Warning", 7, T0 + 20)), T0);
    let (rows, _) = store.page(&query(Show::All));
    assert_eq!(rows.len(), 2);
    let RowSays::Event { event } = &rows[0].what else {
        panic!("{rows:?}")
    };
    assert_eq!(event.count, Some(7));
    let (newer, more) = store.page(&TimelineQuery {
        after: Some(seen),
        ..query(Show::All)
    });
    assert_eq!((newer.len(), more), (1, false));
    assert_eq!(newer[0].id, "e1");
}

/// A pod's start-up noise cannot push a warning out. Fails if the classes
/// share one bound, or the bound lets go without saying so.
#[test]
fn normal_events_past_their_bound_let_go_of_their_own_and_say_so() {
    let mut store = Store::default();
    store.record(series_row(event("warn", "Warning", 1, T0)), T0);
    for n in 0..=MAX_NORMAL {
        let at = T0 + 1 + i64::try_from(n).unwrap();
        store.record(series_row(event(&format!("n{n}"), "Normal", 1, at)), T0);
    }
    let (warnings, _) = store.page(&query(Show::Warnings));
    assert_eq!(warnings.len(), 1);
    let said = store.let_go();
    assert_eq!(said.normal.map(|l| l.before), Some(T0 + 1));
    assert_eq!((said.warnings, said.changes), (None, None));
}

/// The cap a change row meets is said, so the stretch it leaves is never
/// drawn as a quiet one. Fails if the oldest goes silently.
#[test]
fn changes_past_their_bound_say_where_they_were_let_go() {
    let mut store = Store::default();
    for n in 0..=MAX_CHANGES {
        let at = T0 + i64::try_from(n).unwrap();
        store.record(
            change(&n.to_string(), at, "ConfigMap", Some("shop"), "a"),
            T0,
        );
    }
    assert_eq!(
        store.let_go().changes.map(|l| (l.before, l.cleared)),
        Some((T0, false))
    );
}

/// Rows older than any window go without a word: no page reaches them.
#[test]
fn rows_past_the_widest_window_go_without_being_said_to() {
    let mut store = Store::default();
    store.record(
        change("old", T0 - KEEP_FOR_MS - 1, "ConfigMap", Some("shop"), "a"),
        T0,
    );
    assert!(store.page(&query(Show::All)).0.is_empty());
    assert_eq!(store.let_go().changes, None);
}

/// One answer stays under the IPC budget, and the next page starts where it
/// stopped. Fails if a page grows past either bound, or paging skips or
/// repeats a row.
#[test]
fn pages_stay_under_their_bounds_and_follow_on_without_a_gap() {
    let mut store = Store::default();
    for n in 0..1_200 {
        let mut row = change(&n.to_string(), T0 + n, "ConfigMap", Some("shop"), "a");
        row.what = RowSays::Changed {
            fields: vec![moved(
                "metadata.labels.x",
                Some(&"a".repeat(200)),
                Some("b"),
            )],
            more: 0,
            before: None,
        };
        store.record(row, T0);
    }
    let mut seen = Vec::new();
    let mut before = None;
    let mut pages = 0;
    loop {
        let (rows, more) = store.page(&TimelineQuery {
            before,
            ..query(Show::All)
        });
        pages += 1;
        assert!(rows.len() <= PAGE_ROWS);
        assert!(serde_json::to_vec(&rows).unwrap().len() <= PAGE_BYTES + rows.len() + 2);
        before = rows.last().map(|row| Cursor {
            at: row.at,
            seq: row.seq,
        });
        seen.extend(rows.into_iter().map(|row| row.at));
        if !more {
            break;
        }
    }
    let expected: Vec<i64> = (0..1_200).rev().map(|n| T0 + n).collect();
    assert_eq!(seen, expected);
    assert!(pages > 2, "the bytes bound never cut a page");
}

/// "Changes only" has no events and "Warnings only" nothing but warnings.
#[test]
fn each_filter_shows_its_own_rows() {
    let mut store = Store::default();
    store.record(change("c", T0, "Deployment", Some("shop"), "api"), T0);
    store.record(series_row(event("w", "Warning", 1, T0 + 1)), T0);
    store.record(series_row(event("n", "Normal", 1, T0 + 2)), T0);
    let ids = |show| -> Vec<String> {
        store
            .page(&query(show))
            .0
            .into_iter()
            .map(|row| row.id)
            .collect()
    };
    assert_eq!(ids(Show::All), ["n", "w", "c"]);
    assert_eq!(ids(Show::Changes), ["c"]);
    assert_eq!(ids(Show::Warnings), ["w"]);
}

/// A node is every namespace's; a Namespace row is its own namespace's.
#[test]
fn a_scope_keeps_cluster_rows_and_the_namespaces_own() {
    let mut store = Store::default();
    store.record(change("1", T0, "Node", None, "worker"), T0);
    store.record(change("2", T0 + 1, "Namespace", None, "shop"), T0);
    store.record(change("3", T0 + 2, "Namespace", None, "kube-system"), T0);
    store.record(
        change("4", T0 + 3, "ConfigMap", Some("kube-system"), "x"),
        T0,
    );
    store.record(change("5", T0 + 4, "ConfigMap", Some("shop"), "y"), T0);
    store.record(change("6", T0 + 5, "Secret", Some("shop"), "y"), T0);
    let (rows, _) = store.page(&TimelineQuery {
        scope: Some(vec!["shop".into()]),
        ..query(Show::All)
    });
    let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids, ["6", "5", "2", "1"]);
    let (one, _) = store.page(&TimelineQuery {
        subject: Some(Subject {
            kind: "ConfigMap".into(),
            group: None,
            namespace: Some("shop".into()),
            name: "y".into(),
        }),
        ..query(Show::All)
    });
    assert_eq!(one.len(), 1);
}

/// A machine asleep watched nothing. Fails if a late heartbeat stretches
/// the span over the hours it slept.
#[test]
fn a_late_heartbeat_ends_the_span_where_it_was_last_alive() {
    let mut spans = SpanSets::default();
    spans.begin(Source::Followed, T0, Cover::default());
    spans.heartbeat(T0 + HEARTBEAT_MS);
    let woke = T0 + HEARTBEAT_MS + HEARTBEAT_MISSED_MS + 1;
    spans.heartbeat(woke);
    let list = &spans.followed;
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].to, Some(T0 + HEARTBEAT_MS));
    assert_eq!((list[1].from, list[1].to), (woke, None));
}

/// What was open when the app last ran ended with it. Fails if a span read
/// back still runs, which draws the hours the app was closed as watched.
#[test]
fn a_span_read_back_ends_where_it_was_last_alive() {
    let mut spans = SpanSets::default();
    spans.begin(Source::Meta, T0, Cover::default());
    spans.heartbeat(T0 + HEARTBEAT_MS);
    spans.closed();
    assert_eq!(spans.meta[0].to, Some(T0 + HEARTBEAT_MS));
    assert!(!spans.open(Source::Meta));
}

/// Spans that watched alike fold; one refused a kind stays apart, so the
/// refusal is still said; an old one goes.
#[test]
fn spans_fold_only_where_they_watched_alike() {
    let refused = Cover {
        unwatched: vec!["Secret".into()],
        ..Cover::default()
    };
    let mut spans = SpanSets::default();
    spans.begin(Source::Followed, T0 - KEEP_FOR_MS - 10, Cover::default());
    spans.end(Source::Followed, T0 - KEEP_FOR_MS - 5);
    spans.begin(Source::Followed, T0, Cover::default());
    spans.end(Source::Followed, T0 + 10);
    spans.begin(Source::Followed, T0 + 10, Cover::default());
    spans.end(Source::Followed, T0 + 20);
    spans.begin(Source::Followed, T0 + 20, refused);
    spans.prune(T0 + 30);
    let list = &spans.followed;
    assert_eq!(list.len(), 2, "{list:?}");
    assert_eq!((list[0].from, list[0].to), (T0, Some(T0 + 20)));
    assert_eq!(list[1].unwatched, ["Secret"]);
}

#[cfg(unix)]
fn mode_of(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

/// What the timeline keeps is the reader's alone, as `config.toml` is, and
/// never holds a value it withheld or the digest it compared it by. Fails
/// if a file is readable by others, or either reaches the disk or the window.
#[cfg(unix)]
#[test]
fn kept_files_are_private_and_hold_no_value_and_no_digest() {
    let root = tempfile::tempdir().unwrap();
    let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
    let cluster = timelines.cluster("kind");
    let secret = |value: &str| {
        json!({"metadata": {"name": "db", "namespace": "shop"}, "type": "Opaque",
               "data": {"password": value}})
    };
    let before = snap("Secret", "", &secret("aHVudGVyMg=="));
    let after = snap("Secret", "", &secret("c3dvcmRmaXNo"));
    let mut row = change("1", ClusterTimeline::now(), "Secret", Some("shop"), "db");
    row.what = changed(&before, &after).unwrap();
    cluster.change(row);
    cluster.spans(|spans, now| spans.begin(Source::Followed, now, Cover::default()));
    timelines.flush();

    let dir = disk::dir_of(root.path(), "kind");
    assert_eq!(mode_of(&dir), 0o700);
    let digests = [digest("aHVudGVyMg=="), digest("c3dvcmRmaXNo")];
    let mut files = 0;
    for file in std::fs::read_dir(&dir).unwrap().flatten() {
        files += 1;
        assert_eq!(mode_of(&file.path()), 0o600, "{:?}", file.path());
        let text = std::fs::read_to_string(file.path()).unwrap();
        assert!(!text.contains("aHVudGVyMg==") && !text.contains("c3dvcmRmaXNo"));
        for digest in digests {
            assert!(!text.contains(&digest.to_string()) && !text.contains(&format!("{digest:x}")));
        }
    }
    assert_eq!(files, 2, "a state file and a segment");
    let page = serde_json::to_string(&cluster.page(&query(Show::All))).unwrap();
    assert!(page.contains("data.password"));
    for digest in digests {
        assert!(!page.contains(&digest.to_string()) && !page.contains(&format!("{digest:x}")));
    }
}

/// Yesterday's rows are there after a restart, and the span that was open
/// ends where the app last ran. Fails if either is lost or the span runs on.
#[test]
fn a_restart_reads_back_the_rows_and_ends_the_open_span() {
    let root = tempfile::tempdir().unwrap();
    let now = ClusterTimeline::now();
    {
        let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
        let cluster = timelines.cluster("kind");
        cluster.change(change("1", now, "Deployment", Some("shop"), "api"));
        cluster.event(event("e1", "Warning", 3, now), now);
        cluster.spans(|spans, at| spans.begin(Source::Followed, at, Cover::default()));
        timelines.flush();
    }
    let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
    let page = timelines.cluster("kind").page(&query(Show::All));
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.unreadable, 0);
    let span = &page.spans.followed[0];
    assert_eq!(span.to, Some(span.seen_at));
    assert_eq!(page.keeping, Keeping::Kept);
    assert!(page.newest >= 2);
}

/// A line the app could not read is skipped and counted, not a reason to
/// lose the rest. Fails if one bad line empties the timeline or goes unsaid.
#[test]
fn an_unreadable_line_is_skipped_and_counted() {
    let root = tempfile::tempdir().unwrap();
    let now = ClusterTimeline::now();
    {
        let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
        timelines
            .cluster("kind")
            .change(change("1", now, "Deployment", Some("shop"), "api"));
        timelines.flush();
    }
    let segment = disk::dir_of(root.path(), "kind").join("changes-000001.jsonl");
    crate::config::private_file::append(&segment, b"{not json\n").unwrap();
    let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
    let page = timelines.cluster("kind").page(&query(Show::All));
    assert_eq!((page.rows.len(), page.unreadable), (1, 1));
}

/// Keeping off writes nothing and says the timeline lasts this session.
#[test]
fn with_keeping_off_nothing_is_written() {
    let root = tempfile::tempdir().unwrap();
    let (timelines, _rx) = holder(Some(root.path().to_path_buf()), false);
    let cluster = timelines.cluster("kind");
    cluster.change(change(
        "1",
        ClusterTimeline::now(),
        "Deployment",
        Some("shop"),
        "api",
    ));
    timelines.flush();
    assert!(!disk::dir_of(root.path(), "kind").exists());
    assert_eq!(cluster.page(&query(Show::All)).keeping, Keeping::Off);
    assert_eq!(timelines.kept().bytes, 0);
}

/// A disk that refuses is said, and the session's rows stay. Fails if a
/// write error passes as kept.
#[test]
fn a_disk_that_refuses_is_said() {
    let root = tempfile::tempdir().unwrap();
    let blocker = root.path().join("file");
    std::fs::write(&blocker, b"x").unwrap();
    let (timelines, _rx) = holder(Some(blocker), true);
    let cluster = timelines.cluster("kind");
    cluster.change(change(
        "1",
        ClusterTimeline::now(),
        "Deployment",
        Some("shop"),
        "api",
    ));
    timelines.flush();
    let page = cluster.page(&query(Show::All));
    assert!(
        matches!(page.keeping, Keeping::Failed { .. }),
        "{:?}",
        page.keeping
    );
    assert_eq!(page.rows.len(), 1);
}

/// Clearing forgets what was kept, here and on disk, and says the rows were
/// cleared rather than drawing their stretch quiet.
#[test]
fn clearing_forgets_everything_and_says_so() {
    let root = tempfile::tempdir().unwrap();
    let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
    let cluster = timelines.cluster("kind");
    cluster.change(change(
        "1",
        ClusterTimeline::now(),
        "Deployment",
        Some("shop"),
        "api",
    ));
    timelines.flush();
    timelines.clear().unwrap();
    let page = cluster.page(&query(Show::All));
    assert!(page.rows.is_empty());
    assert!(page.let_go.changes.is_some_and(|l| l.cleared));
    timelines.flush();
    let (again, _rx) = holder(Some(root.path().to_path_buf()), true);
    let read = again.cluster("kind").page(&query(Show::All));
    assert!(read.rows.is_empty());
    assert!(read.let_go.warnings.is_some_and(|l| l.cleared));
}

/// Another cluster under the name is not this one's history. Fails if a
/// rebuilt cluster inherits the old rows, or a reader who cannot read
/// `kube-system` loses theirs.
#[test]
fn another_cluster_under_the_name_starts_over_and_an_unknown_one_does_not() {
    let (timelines, _rx) = holder(None, false);
    let cluster = timelines.cluster("kind");
    assert!(!cluster.seen_cluster(Some("uid-a".into())));
    cluster.change(change(
        "1",
        ClusterTimeline::now(),
        "Deployment",
        Some("shop"),
        "api",
    ));
    assert!(!cluster.seen_cluster(None));
    assert_eq!(cluster.page(&query(Show::All)).rows.len(), 1);
    assert!(cluster.seen_cluster(Some("uid-b".into())));
    assert!(cluster.page(&query(Show::All)).rows.is_empty());
}

/// The window is told once a flush, and only of a cluster that recorded.
#[test]
fn the_window_is_told_once_a_flush_for_a_cluster_that_recorded() {
    let (timelines, mut rx) = holder(None, false);
    let cluster = timelines.cluster("kind");
    timelines.cluster("quiet");
    cluster.change(change(
        "1",
        ClusterTimeline::now(),
        "Deployment",
        Some("shop"),
        "api",
    ));
    cluster.change(change(
        "2",
        ClusterTimeline::now(),
        "Deployment",
        Some("shop"),
        "api",
    ));
    timelines.flush();
    timelines.flush();
    let mut told = Vec::new();
    while let Ok(event) = rx.try_recv() {
        told.push(event.to_json().unwrap());
    }
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].contains("\"context\":\"kind\""));
}

/// The size bound goes by whole segments, oldest first, and says what went.
#[test]
fn segments_past_their_count_go_oldest_first_and_are_said() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("c");
    std::fs::create_dir_all(&dir).unwrap();
    for n in 1..=10 {
        std::fs::write(dir.join(format!("changes-{n:06}.jsonl")), b"").unwrap();
    }
    let state = disk::State::default();
    let let_go = disk::write(
        &dir,
        &disk::Pending::default(),
        Some(&state),
        ClusterTimeline::now(),
    )
    .unwrap();
    assert!(!dir.join("changes-000001.jsonl").exists());
    assert!(!dir.join("changes-000002.jsonl").exists());
    assert!(dir.join("changes-000003.jsonl").exists());
    assert!(let_go.changes.is_some());
    assert_eq!(let_go.warnings, None);
}

/// A segment older than the widest window is not read back and goes.
#[test]
fn a_segment_past_the_widest_window_is_neither_read_nor_kept() {
    let root = tempfile::tempdir().unwrap();
    let now = ClusterTimeline::now();
    {
        let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
        timelines
            .cluster("kind")
            .change(change("1", now, "Deployment", Some("shop"), "api"));
        timelines.flush();
    }
    let segment = disk::dir_of(root.path(), "kind").join("changes-000001.jsonl");
    let long_ago = std::time::SystemTime::now()
        - std::time::Duration::from_millis(u64::try_from(KEEP_FOR_MS).unwrap() + 60_000);
    std::fs::File::options()
        .write(true)
        .open(&segment)
        .unwrap()
        .set_modified(long_ago)
        .unwrap();
    let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
    let cluster = timelines.cluster("kind");
    assert!(cluster.page(&query(Show::All)).rows.is_empty());
    cluster.change(change("2", now, "Deployment", Some("shop"), "api"));
    timelines.flush();
    let (again, _rx) = holder(Some(root.path().to_path_buf()), true);
    let page = again.cluster("kind").page(&query(Show::All));
    let ids: Vec<&str> = page.rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids, ["2"]);
    assert_eq!(page.let_go.changes, None);
}

/// What a followed object costs to hold, and a first list of ten thousand
/// `ConfigMaps` and `Secrets` to read, for the bounds the timeline states. Run
/// with `--ignored --nocapture`; it measures, so it asserts only that the
/// numbers came out.
#[test]
#[ignore = "measures; run by hand"]
fn what_a_followed_object_costs() {
    use k8s_openapi::api::core::v1::{ConfigMap, Secret};
    let ca = "MIIC/jCCAeagAwIBAgIBADANBgkqhkiG9w0BAQsFADAVMRMwEQYDVQQDEwprdWJl".repeat(18);
    let config_map = |n: usize| -> ConfigMap {
        serde_json::from_value(json!({
            "metadata": {"name": "kube-root-ca.crt", "namespace": format!("perf-{n}"),
                "annotations": {"kubernetes.io/description": "Contains a CA bundle"}},
            "data": {"ca.crt": ca}
        }))
        .unwrap()
    };
    let secret = |n: usize| -> Secret {
        serde_json::from_value(json!({
            "metadata": {"name": format!("app-{n}"), "namespace": "perf-0",
                "labels": {"app": "api"}},
            "type": "Opaque",
            "data": {"user": "YWRtaW4=", "password": "aHVudGVyMg==", "url": "cG9zdGdyZXM6Ly8="}
        }))
        .unwrap()
    };
    for (what, object) in [
        ("Deployment", deployment("nginx:1.27", 3, "v")),
        ("ConfigMap", serde_json::to_value(config_map(0)).unwrap()),
        ("Secret", serde_json::to_value(secret(0)).unwrap()),
        ("Node", node(false, "True", "10:00")),
    ] {
        let group = if what == "Deployment" { "apps" } else { "" };
        println!(
            "{what}: {} bytes held",
            snap(what, group, &object).heap_bytes()
        );
    }
    for (what, project) in [
        (
            "ConfigMap",
            Box::new(|n| serde_json::to_value(config_map(n)).unwrap())
                as Box<dyn Fn(usize) -> Value>,
        ),
        (
            "Secret",
            Box::new(|n| serde_json::to_value(secret(n)).unwrap()),
        ),
    ] {
        let objects: Vec<Value> = (0..10_000).map(&project).collect();
        let started = std::time::Instant::now();
        let held: usize = objects
            .iter()
            .map(|object| snap(what, "", object).heap_bytes())
            .sum();
        println!(
            "10 000 {what}s: {:?} to read, {} KiB held",
            started.elapsed(),
            held / 1024
        );
        assert!(held > 0);
    }
}

/// What is read by name only is held open for a timeline on screen and no
/// longer. Fails if a word from the window holds it for good, or not at all.
#[test]
fn a_surface_on_screen_holds_its_cluster_for_a_while_and_no_longer() {
    let (timelines, _rx) = holder(None, false);
    let now = std::time::Instant::now();
    assert!(!timelines.held("kind", now));
    timelines.hold("kind");
    assert!(timelines.held("kind", std::time::Instant::now()));
    assert!(!timelines.held("other", std::time::Instant::now()));
    assert!(!timelines.held("kind", std::time::Instant::now() + HELD_FOR));
}

mod recording {
    use super::*;
    use crate::timeline::project::FOLLOWED;
    use crate::timeline::recorder::{Named, Recorder, Slot, SlotState};

    fn followed_kind(kind: &str) -> &'static project::Followed {
        FOLLOWED.iter().find(|f| f.kind == kind).expect("followed")
    }

    fn recorder() -> (Arc<Timelines>, Arc<ClusterTimeline>, Recorder) {
        let (timelines, _rx) = holder(None, false);
        let cluster = timelines.cluster("kind");
        let recorder = Recorder::new(cluster.clone(), vec!["shop".into()]);
        (timelines, cluster, recorder)
    }

    fn rows(cluster: &ClusterTimeline) -> Vec<TimelineRow> {
        cluster.page(&query(Show::All)).rows
    }

    fn says(row: &TimelineRow) -> &'static str {
        match row.what {
            RowSays::Created => "created",
            RowSays::Deleted => "deleted",
            RowSays::Changed { .. } => "changed",
            RowSays::Generation { .. } => "generation",
            RowSays::Event { .. } => "event",
        }
    }

    fn slot(kind: &str, namespace: Option<&str>) -> Slot {
        Slot {
            kind: kind.into(),
            namespace: namespace.map(str::to_string),
        }
    }

    /// A first list is what was there, not what changed. Fails if it writes
    /// a row per object, or the change after it is not one.
    #[test]
    fn a_first_list_is_a_baseline_and_the_change_after_it_is_a_row() {
        let (_t, cluster, mut recorder) = recorder();
        let kind = followed_kind("Deployment");
        recorder.listed(kind, [&deployment("nginx:1", 2, "v")], false);
        assert!(rows(&cluster).is_empty());
        recorder.applied(kind, &deployment("nginx:2", 2, "v"));
        let found = rows(&cluster);
        assert_eq!(found.len(), 1);
        assert_eq!(says(&found[0]), "changed");
        assert!(!found[0].at_relist);
    }

    /// What changed while nothing watched is noticed at the list after the
    /// break, and said to have been. Fails if it is lost, or passed off as
    /// seen happening.
    #[test]
    fn a_list_after_a_break_says_what_moved_in_the_gap() {
        let (_t, cluster, mut recorder) = recorder();
        let kind = followed_kind("ConfigMap");
        let cm = |name: &str, value: &str| {
            json!({"metadata": {"name": name, "namespace": "shop",
                "creationTimestamp": "2026-11-01T00:00:00Z"}, "data": {"k": value}})
        };
        recorder.listed(kind, [&cm("a", "1"), &cm("gone", "1")], false);
        recorder.listed(kind, [&cm("a", "2"), &cm("new", "1")], true);
        let mut found: Vec<(&str, String, bool)> = rows(&cluster)
            .iter()
            .map(|row| (says(row), row.name.clone(), row.at_relist))
            .collect();
        found.sort();
        assert_eq!(
            found,
            [
                ("changed", "a".to_string(), true),
                ("created", "new".to_string(), true),
                ("deleted", "gone".to_string(), true)
            ]
        );
    }

    /// An object deleted and then reported again late is not born again;
    /// one made anew under the name is. Fails if either is said wrong.
    #[test]
    fn a_late_report_of_a_deleted_object_does_not_revive_it_and_a_new_one_is_created() {
        let (_t, cluster, mut recorder) = recorder();
        let kind = followed_kind("Deployment");
        let old = deployment("nginx:1", 2, "v");
        recorder.listed(kind, [&old], false);
        recorder.deleted(kind, &old);
        recorder.applied(kind, &old);
        let mut anew = deployment("nginx:1", 2, "v");
        anew["metadata"]["creationTimestamp"] = json!("2026-11-02T00:00:00Z");
        recorder.applied(kind, &anew);
        let found: Vec<&str> = rows(&cluster).iter().map(says).collect();
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.contains(&"deleted") && found.contains(&"created"));
    }

    fn followed_spans(cluster: &ClusterTimeline) -> Vec<ObservedSpan> {
        cluster.page(&query(Show::All)).spans.followed
    }

    /// The span opens once every watch has listed or been refused, names a
    /// refused kind, and ends when one goes blind or lists again. Fails if a
    /// kind nobody was let watch is spoken for, or a blind stretch is drawn
    /// as watched.
    #[test]
    fn the_span_opens_on_every_watch_and_names_what_was_refused() {
        let (_t, cluster, mut recorder) = recorder();
        for kind in ["Deployment", "Secret", "Event"] {
            recorder.state(Source::Followed, slot(kind, None), SlotState::Listing);
        }
        recorder.state(Source::Followed, slot("Deployment", None), SlotState::Live);
        recorder.state(Source::Followed, slot("Event", None), SlotState::Live);
        assert!(
            followed_spans(&cluster).is_empty(),
            "opened while Secret listed"
        );
        recorder.state(Source::Followed, slot("Secret", None), SlotState::Refused);
        let open = followed_spans(&cluster);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].unwatched, ["Secret"]);
        assert_eq!(open[0].kinds, ["Deployment", "Secret"]);
        assert_eq!(open[0].to, None);
        recorder.state(Source::Followed, slot("Deployment", None), SlotState::Blind);
        assert!(followed_spans(&cluster)[0].to.is_some());
    }

    /// A kind refused across the cluster and read in the window's namespaces
    /// is watched there and nowhere else. Fails if the span claims the whole
    /// cluster, or names the namespaces it was refused in too.
    #[test]
    fn a_kind_read_in_some_namespaces_narrows_the_span_and_names_the_rest() {
        let (_t, cluster, mut recorder) = recorder();
        recorder.state(Source::Followed, slot("Deployment", None), SlotState::Live);
        recorder.state(Source::Followed, slot("Secret", None), SlotState::Refused);
        recorder.state(
            Source::Followed,
            slot("Secret", Some("shop")),
            SlotState::Live,
        );
        recorder.state(
            Source::Followed,
            slot("Secret", Some("ops")),
            SlotState::Refused,
        );
        let span = followed_spans(&cluster).pop().expect("a span");
        assert_eq!(span.scope, ["shop"]);
        assert_eq!(span.unwatched_in, ["Secret/ops"]);
        assert!(span.unwatched.is_empty());
    }

    /// A refusal that arrives while watching is a new stretch with its own
    /// words. Fails if the span goes on claiming the kind it lost.
    #[test]
    fn a_refusal_while_watching_starts_a_span_that_says_it() {
        let (_t, cluster, mut recorder) = recorder();
        recorder.state(Source::Followed, slot("Secret", None), SlotState::Listing);
        recorder.state(Source::Followed, slot("Deployment", None), SlotState::Live);
        recorder.state(Source::Followed, slot("Secret", None), SlotState::Live);
        recorder.state(Source::Followed, slot("Secret", None), SlotState::Refused);
        let spans = followed_spans(&cluster);
        assert_eq!(spans.len(), 2);
        assert!(spans[0].to.is_some() && spans[0].unwatched.is_empty());
        assert_eq!(spans[1].unwatched, ["Secret"]);
    }

    fn named(uid: &str, generation: Option<i64>, controlled: bool) -> Named {
        Named {
            kind: "Job".into(),
            group: "batch".into(),
            uid: uid.into(),
            name: format!("job-{uid}"),
            namespace: Some("shop".into()),
            generation,
            controlled,
        }
    }

    /// Seen by name only: a moved generation is a row that says so, a birth
    /// a controller made is its owner's, and a kind that keeps no generation
    /// says nothing of a change it cannot see. Fails if any of the three is
    /// said otherwise.
    #[test]
    fn a_kind_seen_by_name_says_its_generation_and_leaves_owned_births_to_their_owner() {
        let (_t, cluster, mut recorder) = recorder();
        recorder.named_applied(&named("a", Some(1), false), false);
        recorder.named_applied(&named("b", None, false), false);
        assert!(rows(&cluster).is_empty(), "a first sight is a baseline");
        recorder.named_applied(&named("a", Some(2), false), true);
        recorder.named_applied(&named("b", None, false), true);
        recorder.named_applied(&named("c", Some(1), true), true);
        recorder.named_applied(&named("d", Some(1), false), true);
        recorder.named_deleted("c");
        recorder.named_deleted("d");
        let found: Vec<(&str, String)> = rows(&cluster)
            .iter()
            .map(|row| (says(row), row.name.clone()))
            .collect();
        assert_eq!(found.len(), 3, "{found:?}");
        assert!(found.contains(&("generation", "job-a".to_string())));
        assert!(found.contains(&("created", "job-d".to_string())));
        assert!(found.contains(&("deleted", "job-d".to_string())));
    }
}
