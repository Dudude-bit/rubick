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

/// kapp, Rancher and others keep a copy of the object in an annotation of
/// their own naming, a Secret's values and a container's env literals with
/// it. Fails if such a value reaches a row under any name, or a short plain
/// annotation stops being said.
#[test]
fn an_annotation_that_may_copy_the_object_is_compared_by_digest_alone() {
    let secret = |value: &str| {
        let copy = json!({"apiVersion": "v1", "data": {"password": value}, "kind": "Secret"});
        json!({"metadata": {"name": "db", "namespace": "shop",
            "annotations": {"kapp.k14s.io/original": copy.to_string(), "team": value}},
            "type": "Opaque", "data": {"password": value}})
    };
    let said = changed(
        &snap("Secret", "", &secret("aHVudGVyMg==")),
        &snap("Secret", "", &secret("c3dvcmRmaXNo")),
    )
    .expect("a change");
    let wire = serde_json::to_string(&said).unwrap();
    assert!(
        !wire.contains("aHVudGVyMg==") && !wire.contains("c3dvcmRmaXNo"),
        "{wire}"
    );
    assert!(
        wire.contains("metadata.annotations[kapp.k14s.io/original]"),
        "{wire}"
    );

    let annotated = |note: &str, at: &str| {
        let mut object = deployment("nginx:1", 2, note);
        let copy = deployment("nginx:1", 2, note).to_string();
        object["metadata"]["annotations"] = json!({
            "banzaicloud.com/last-applied": copy,
            "objectset.rio.cattle.io/applied": format!("H4sIAAAAAAAA/{}", note.repeat(60)),
            "kubectl.kubernetes.io/restartedAt": at,
        });
        object
    };
    let found = moves(
        &snap("Deployment", "apps", &annotated("first-value", "10:00")),
        &snap("Deployment", "apps", &annotated("second-value", "11:00")),
    );
    let wire = serde_json::to_string(&found).unwrap();
    assert!(
        !wire.contains("first-value") && !wire.contains("second-value"),
        "{wire}"
    );
    assert!(found.contains(&moved(
        "metadata.annotations[kubectl.kubernetes.io/restartedAt]",
        Some("10:00"),
        Some("11:00")
    )));
    for key in [
        "banzaicloud.com/last-applied",
        "objectset.rio.cattle.io/applied",
    ] {
        let path = format!("metadata.annotations[{key}]");
        assert!(
            found.contains(&FieldMove::NotKept {
                path: path.clone(),
                was: true,
                is: true
            }),
            "{path}: {wire}"
        );
    }
}

/// Istio renews its election in a `ConfigMap` annotation every few seconds:
/// three such rows took nine of sixteen lines on screen, without end. Fails
/// if a renewal alone is a row, or a data change made with it is lost.
#[test]
fn a_leader_election_renewal_is_not_a_change() {
    let lock = |renewed: &str, data: &str| {
        let record = format!(r#"{{"holderIdentity":"istiod-1","renewTime":"{renewed}"}}"#);
        json!({"metadata": {"name": "istio-leader", "namespace": "istio-system",
            "annotations": {"control-plane.alpha.kubernetes.io/leader": record}},
            "data": {"k": data}})
    };
    let at = |renewed: &str, data: &str| snap("ConfigMap", "", &lock(renewed, data));
    let before = at("2026-11-17T10:00:00Z", "a");
    assert!(changed(&before, &at("2026-11-17T10:00:02Z", "a")).is_none());
    let found = moves(&before, &at("2026-11-17T10:00:04Z", "b"));
    assert_eq!(
        found,
        [FieldMove::NotKept {
            path: "data.k".into(),
            was: true,
            is: true
        }]
    );
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

/// Every renewal hands each event over again. Fails if one held as it is
/// takes a new number, which writes it to disk again and sends it to the
/// window again, or a real repeat is not recorded.
#[test]
fn an_event_handed_over_again_as_it_is_held_is_not_recorded_again() {
    let (timelines, _rx) = holder(None, false);
    let cluster = timelines.cluster("kind");
    let now = ClusterTimeline::now();
    cluster.event(event("e1", "Warning", 3, now), now);
    let newest = cluster.page(&query(Show::All)).newest;
    cluster.event(event("e1", "Warning", 3, now), now + 1000);
    assert_eq!(cluster.page(&query(Show::All)).newest, newest);
    cluster.event(event("e1", "Warning", 4, now + 1000), now + 1000);
    assert_eq!(cluster.page(&query(Show::All)).newest, newest + 1);
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
        subject: Some(TimelineSubject {
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

/// The laptop slept eight hours, and on waking a watch broke before the
/// heartbeat ran. Fails if the span that break ended covers the sleep, or a
/// span ended in time does not end then.
#[test]
fn a_span_ended_after_a_sleep_ends_where_it_was_last_alive() {
    let mut spans = SpanSets::default();
    spans.begin(Source::Followed, T0, Cover::default());
    spans.heartbeat(T0 + HEARTBEAT_MS);
    spans.end(Source::Followed, T0 + 8 * 60 * 60 * 1000);
    assert_eq!(spans.followed[0].to, Some(T0 + HEARTBEAT_MS));
    spans.begin(Source::Meta, T0, Cover::default());
    spans.end(Source::Meta, T0 + HEARTBEAT_MS);
    assert_eq!(spans.meta[0].to, Some(T0 + HEARTBEAT_MS));
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

/// A machine with no data folder keeps nothing between restarts. Fails if
/// the timeline says it is kept while there is nowhere to keep it.
#[test]
fn with_no_data_folder_keeping_on_is_said_to_keep_nothing() {
    let (timelines, _rx) = holder(None, true);
    let cluster = timelines.cluster("kind");
    assert_eq!(cluster.page(&query(Show::All)).keeping, Keeping::Nowhere);
    timelines.set_keep(false);
    assert_eq!(cluster.page(&query(Show::All)).keeping, Keeping::Off);
    timelines.set_keep(true);
    assert_eq!(cluster.page(&query(Show::All)).keeping, Keeping::Nowhere);
}

/// Two switches of keeping that meet: one saves on, the other saves off and
/// applies it, then the first applies on. Fails if the file and the app end
/// up disagreeing, which keeps writing a timeline the reader turned off.
#[tokio::test]
async fn two_keeping_switches_that_meet_end_as_the_file_says() {
    let (timelines, _rx) = holder(None, false);
    let saved = Arc::new(Mutex::new(None));
    let slow = {
        let saved = saved.clone();
        async move {
            *saved.lock() = Some(true);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            Ok::<(), ()>(())
        }
    };
    let fast = {
        let saved = saved.clone();
        async move {
            *saved.lock() = Some(false);
            Ok::<(), ()>(())
        }
    };
    let first = {
        let timelines = timelines.clone();
        tokio::spawn(async move { timelines.keep_saved(true, slow).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    timelines.keep_saved(false, fast).await.unwrap();
    first.await.unwrap().unwrap();
    assert_eq!(*saved.lock(), Some(timelines.keeps()));
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

/// Keeping off from ten to eleven, then on again: the rows of that hour were
/// never written, and the spans written after cover it. Fails if, read back
/// after a restart, that hour is watched, which draws it quiet over the
/// rollouts made in it.
#[test]
fn a_stretch_whose_rows_were_not_kept_is_not_written_as_watched() {
    let root = tempfile::tempdir().unwrap();
    let pause = || std::thread::sleep(std::time::Duration::from_millis(5));
    let (timelines, _rx) = holder(Some(root.path().to_path_buf()), false);
    let cluster = timelines.cluster("kind");
    cluster.spans(|spans, now| spans.begin(Source::Followed, now, Cover::default()));
    pause();
    let recorded = ClusterTimeline::now();
    cluster.change(change("1", recorded, "Deployment", Some("shop"), "api"));
    pause();
    cluster.spans(SpanSets::heartbeat);
    pause();
    timelines.flush();
    pause();
    timelines.set_keep(true);
    timelines.flush();
    let (again, _rx) = holder(Some(root.path().to_path_buf()), true);
    let read = again.cluster("kind").page(&query(Show::All));
    assert!(read.rows.is_empty());
    assert!(
        read.spans
            .followed
            .iter()
            .all(|span| recorded < span.from || span.to.is_some_and(|to| to < recorded)),
        "{:?}",
        read.spans.followed
    );
}

/// A cluster with nothing new is not written again: an idle app was a full
/// fsync a second per cluster, and a context only read was a folder in
/// Settings. Fails if a flush writes a cluster that recorded nothing.
#[test]
fn a_cluster_with_nothing_new_is_not_written() {
    let root = tempfile::tempdir().unwrap();
    let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
    let _read = timelines.cluster("read-only");
    let cluster = timelines.cluster("kind");
    cluster.change(change(
        "1",
        ClusterTimeline::now(),
        "Deployment",
        Some("shop"),
        "api",
    ));
    timelines.flush();
    assert!(!disk::dir_of(root.path(), "read-only").exists());
    let state = disk::dir_of(root.path(), "kind").join("state.json");
    std::fs::remove_file(&state).unwrap();
    timelines.flush();
    assert!(!state.exists());
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
    let epoch = cluster.page(&query(Show::All)).epoch;
    timelines.clear().unwrap();
    let page = cluster.page(&query(Show::All));
    assert!(page.rows.is_empty());
    assert!(
        page.epoch > epoch,
        "a reader holding the cleared rows would keep them"
    );
    assert!(page.let_go.changes.is_some_and(|l| l.cleared));
    timelines.flush();
    let (again, _rx) = holder(Some(root.path().to_path_buf()), true);
    let read = again.cluster("kind").page(&query(Show::All));
    assert!(read.rows.is_empty());
    assert!(read.let_go.warnings.is_some_and(|l| l.cleared));
}

/// Another cluster under the name is not this one's history. Fails if a
/// rebuilt cluster inherits the old rows, a reader holding them is not told
/// the rows started over, or a reader who cannot read `kube-system` loses
/// rows this run recorded.
#[test]
fn another_cluster_under_the_name_starts_over_and_an_unknown_one_does_not() {
    let (timelines, _rx) = holder(None, false);
    let cluster = timelines.cluster("kind");
    assert!(!cluster.seen_cluster("uid-a".into()));
    cluster.change(change(
        "1",
        ClusterTimeline::now(),
        "Deployment",
        Some("shop"),
        "api",
    ));
    cluster.not_identified("namespaces \"kube-system\" is forbidden".into());
    let page = cluster.page(&query(Show::All));
    assert_eq!((page.rows.len(), page.identity), (1, Identity::Known));
    assert!(cluster.seen_cluster("uid-b".into()));
    let again = cluster.page(&query(Show::All));
    assert!(again.rows.is_empty());
    assert!(
        again.epoch > page.epoch,
        "a reader holding the old rows keeps them"
    );
}

/// Rows kept from an earlier run, read by someone who may not read
/// `kube-system`: they may be another cluster's that had the name. Fails if
/// that is not said, or is still said once the cluster was checked.
#[test]
fn rows_kept_before_are_said_to_be_unchecked_where_the_cluster_could_not_be_read() {
    let root = tempfile::tempdir().unwrap();
    {
        let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
        let cluster = timelines.cluster("kind");
        cluster.seen_cluster("uid-a".into());
        cluster.change(change(
            "1",
            ClusterTimeline::now(),
            "Deployment",
            Some("shop"),
            "api",
        ));
        timelines.flush();
    }
    let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
    let cluster = timelines.cluster("kind");
    assert_eq!(
        cluster.page(&query(Show::All)).identity,
        Identity::NotChecked
    );
    cluster.not_identified("forbidden".into());
    assert_eq!(
        cluster.page(&query(Show::All)).identity,
        Identity::Unknown {
            message: "forbidden".into()
        }
    );
    assert!(!cluster.seen_cluster("uid-a".into()));
    let page = cluster.page(&query(Show::All));
    assert_eq!((page.rows.len(), page.identity), (1, Identity::Known));
    let fresh = timelines.cluster("never-kept");
    assert_eq!(fresh.page(&query(Show::All)).identity, Identity::Known);
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

mod recording {
    use super::*;
    use crate::timeline::project::FOLLOWED;
    use crate::timeline::recorder::{Named, Recorder, Sight, Slot, SlotState};

    fn followed_kind(kind: &str) -> &'static project::Followed {
        FOLLOWED.iter().find(|f| f.kind == kind).expect("followed")
    }

    fn recorder() -> (Arc<Timelines>, Arc<ClusterTimeline>, Recorder) {
        let (timelines, _rx) = holder(None, false);
        let cluster = timelines.cluster("kind");
        let recorder = Recorder::new(cluster.clone());
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

    /// A Secret deployed by kapp, its value changed: the tool rewrites the
    /// copy it keeps in an annotation. Fails if either value reaches a kept
    /// file or the window by that copy.
    #[cfg(unix)]
    #[test]
    fn a_secret_copied_into_an_annotation_reaches_no_file_and_no_page() {
        let root = tempfile::tempdir().unwrap();
        let (timelines, _rx) = holder(Some(root.path().to_path_buf()), true);
        let cluster = timelines.cluster("kind");
        let mut recorder = Recorder::new(cluster.clone());
        let secret = |value: &str| {
            let copy = json!({"apiVersion": "v1", "data": {"password": value}, "kind": "Secret"});
            json!({"metadata": {"name": "db", "namespace": "shop",
                "creationTimestamp": "2026-11-01T00:00:00Z",
                "annotations": {"kapp.k14s.io/original": copy.to_string()}},
                "type": "Opaque", "data": {"password": value}})
        };
        let kind = followed_kind("Secret");
        recorder.listed(kind, None, [&secret("aHVudGVyMg==")], true);
        recorder.applied(kind, None, &secret("c3dvcmRmaXNo"));
        timelines.flush();

        let page = serde_json::to_string(&cluster.page(&query(Show::All))).unwrap();
        assert!(page.contains("kapp.k14s.io/original"), "{page}");
        let mut files = 0;
        for file in std::fs::read_dir(disk::dir_of(root.path(), "kind"))
            .unwrap()
            .flatten()
        {
            files += 1;
            let text = std::fs::read_to_string(file.path()).unwrap();
            for said in [&text, &page] {
                assert!(!said.contains("aHVudGVyMg==") && !said.contains("c3dvcmRmaXNo"));
            }
        }
        assert!(files > 0, "nothing was written");
    }

    /// A first list is what was there, not what changed. Fails if it writes
    /// a row per object, or the change after it is not one.
    #[test]
    fn a_first_list_is_a_baseline_and_the_change_after_it_is_a_row() {
        let (_t, cluster, mut recorder) = recorder();
        let kind = followed_kind("Deployment");
        recorder.listed(kind, None, [&deployment("nginx:1", 2, "v")], true);
        assert!(rows(&cluster).is_empty());
        recorder.applied(kind, None, &deployment("nginx:2", 2, "v"));
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
        recorder.listed(kind, None, [&cm("a", "1"), &cm("gone", "1")], true);
        recorder.listed(kind, None, [&cm("a", "2"), &cm("new", "1")], false);
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

    /// A late report of a deleted object, then a list without it. Fails if
    /// the late report held the object again, so the list said it was
    /// deleted a second time.
    #[test]
    fn a_late_report_of_a_deleted_object_is_not_deleted_twice() {
        let (_t, cluster, mut recorder) = recorder();
        let kind = followed_kind("Deployment");
        let old = deployment("nginx:1", 2, "v");
        recorder.listed(kind, None, [&old], true);
        recorder.deleted(kind, None, &old);
        recorder.applied(kind, None, &old);
        recorder.listed(kind, None, std::iter::empty(), false);
        let found: Vec<&str> = rows(&cluster).iter().map(says).collect();
        assert_eq!(found, ["deleted"]);
    }

    /// An object deleted and then reported again late is not born again;
    /// one made anew under the name is. Fails if either is said wrong.
    #[test]
    fn a_late_report_of_a_deleted_object_does_not_revive_it_and_a_new_one_is_created() {
        let (_t, cluster, mut recorder) = recorder();
        let kind = followed_kind("Deployment");
        let old = deployment("nginx:1", 2, "v");
        recorder.listed(kind, None, [&old], true);
        recorder.deleted(kind, None, &old);
        recorder.applied(kind, None, &old);
        let mut anew = deployment("nginx:1", 2, "v");
        anew["metadata"]["creationTimestamp"] = json!("2026-11-02T00:00:00Z");
        recorder.applied(kind, None, &anew);
        let found: Vec<&str> = rows(&cluster).iter().map(says).collect();
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.contains(&"deleted") && found.contains(&"created"));
    }

    /// A CI cluster creating and deleting namespaces all day, each with its
    /// own `ConfigMap`. Fails if the recorder holds something of every object
    /// it ever saw deleted for as long as the app stays connected.
    #[test]
    fn what_is_held_of_the_deleted_lets_go_after_a_while() {
        let (_t, _cluster, mut recorder) = recorder();
        let kind = followed_kind("ConfigMap");
        let cm = |name: &str| {
            json!({"metadata": {"name": name, "namespace": "ci",
                "creationTimestamp": "2026-11-01T00:00:00Z"}})
        };
        let runs: Vec<Value> = (0..100).map(|n| cm(&format!("run-{n}"))).collect();
        recorder.listed(kind, None, runs.iter(), true);
        for run in &runs {
            recorder.deleted_at(kind, None, run, T0);
        }
        assert_eq!(recorder.gone_held(), 100);
        let late = cm("late");
        recorder.applied(kind, None, &late);
        recorder.deleted_at(kind, None, &late, T0 + 11 * 60 * 1000);
        assert_eq!(recorder.gone_held(), 1);
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
            recorder.state(Source::Followed, slot(kind, None), SlotState::Listing, None);
        }
        recorder.state(
            Source::Followed,
            slot("Deployment", None),
            SlotState::Live,
            None,
        );
        recorder.state(Source::Followed, slot("Event", None), SlotState::Live, None);
        assert!(
            followed_spans(&cluster).is_empty(),
            "opened while Secret listed"
        );
        recorder.state(
            Source::Followed,
            slot("Secret", None),
            SlotState::Refused,
            None,
        );
        let open = followed_spans(&cluster);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].unwatched, ["Secret"]);
        assert_eq!(open[0].kinds, ["Deployment", "Secret"]);
        assert_eq!(open[0].to, None);
        recorder.state(
            Source::Followed,
            slot("Deployment", None),
            SlotState::Blind,
            None,
        );
        assert!(followed_spans(&cluster)[0].to.is_some());
    }

    /// A kind refused across the cluster and read in the window's namespaces
    /// is watched there and nowhere else. Fails if the span claims the whole
    /// cluster, or names the namespaces it was refused in too.
    #[test]
    fn a_kind_read_in_some_namespaces_narrows_the_span_and_names_the_rest() {
        let (_t, cluster, mut recorder) = recorder();
        recorder.state(
            Source::Followed,
            slot("Deployment", None),
            SlotState::Live,
            None,
        );
        recorder.state(
            Source::Followed,
            slot("Secret", None),
            SlotState::Refused,
            None,
        );
        recorder.state(
            Source::Followed,
            slot("Secret", Some("shop")),
            SlotState::Live,
            None,
        );
        recorder.state(
            Source::Followed,
            slot("Secret", Some("ops")),
            SlotState::Refused,
            None,
        );
        let span = followed_spans(&cluster).pop().expect("a span");
        assert_eq!(span.scope, ["shop"]);
        assert_eq!(span.unwatched_in, ["Secret/ops"]);
        assert!(span.unwatched.is_empty());
    }

    /// A narrowed span speaks for the namespaces its watches report reading,
    /// another reader's among them, and only where every kind is read. Fails
    /// if it names a namespace one kind was not read in, or a span no
    /// namespace is whole in claims the whole cluster.
    #[test]
    fn a_narrowed_span_speaks_for_where_every_kind_is_read() {
        let (_t, cluster, mut recorder) = recorder();
        for (kind, namespace, state) in [
            ("Deployment", None, SlotState::Refused),
            ("Deployment", Some("shop"), SlotState::Live),
            ("Deployment", Some("payments"), SlotState::Live),
            ("Secret", None, SlotState::Refused),
            ("Secret", Some("shop"), SlotState::Live),
        ] {
            recorder.state(Source::Followed, slot(kind, namespace), state, None);
        }
        assert_eq!(
            followed_spans(&cluster).pop().expect("a span").scope,
            ["shop"]
        );
        recorder.state(
            Source::Followed,
            slot("Secret", Some("shop")),
            SlotState::Refused,
            None,
        );
        let span = followed_spans(&cluster).pop().expect("a span");
        assert_eq!(
            (span.scope, span.unwatched),
            (
                vec!["payments".to_string(), "shop".to_string()],
                vec!["Secret".to_string()]
            )
        );
        recorder.state(
            Source::Followed,
            slot("Secret", Some("ops")),
            SlotState::Live,
            None,
        );
        assert!(followed_spans(&cluster)
            .iter()
            .all(|span| span.to.is_some()));
    }

    /// The window opened on `team-a`, refused, then moved to `audit-test`:
    /// minutes later the header still named `team-a` as refused. Fails if a
    /// namespace the window left is still named, or still holds the span.
    #[test]
    fn a_namespace_the_window_left_is_no_longer_named_as_refused() {
        let (_t, cluster, mut recorder) = recorder();
        for (namespace, state) in [
            (None, SlotState::Refused),
            (Some("team-a"), SlotState::Refused),
            (Some("audit-test"), SlotState::Live),
            (Some("ops"), SlotState::Listing),
        ] {
            recorder.state(Source::Followed, slot("Deployment", namespace), state, None);
        }
        assert!(
            followed_spans(&cluster)
                .iter()
                .all(|span| span.to.is_some()),
            "ops lists"
        );
        recorder.rescope(Some(&["audit-test".to_string()]));
        let span = followed_spans(&cluster).pop().expect("a span");
        assert_eq!(span.to, None);
        assert_eq!(span.scope, ["audit-test"]);
        assert!(span.unwatched_in.is_empty(), "{:?}", span.unwatched_in);
    }

    /// A refusal that arrives while watching is a new stretch with its own
    /// words. Fails if the span goes on claiming the kind it lost.
    #[test]
    fn a_refusal_while_watching_starts_a_span_that_says_it() {
        let (_t, cluster, mut recorder) = recorder();
        recorder.state(
            Source::Followed,
            slot("Secret", None),
            SlotState::Listing,
            None,
        );
        recorder.state(
            Source::Followed,
            slot("Deployment", None),
            SlotState::Live,
            None,
        );
        recorder.state(
            Source::Followed,
            slot("Secret", None),
            SlotState::Live,
            None,
        );
        recorder.state(
            Source::Followed,
            slot("Secret", None),
            SlotState::Refused,
            None,
        );
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

    /// One image set on a Deployment wrote nine by-name rows: the generation
    /// of its `Pod`, both `ReplicaSet`s and an `EndpointSlice`, four times
    /// over. Fails if what a controller made, or an `EndpointSlice`, has a
    /// generation row of its own, or an object nobody owns stops having one.
    #[test]
    fn what_a_controller_made_and_an_endpoint_slice_leave_their_changes_to_their_owner() {
        let (_t, cluster, mut recorder) = recorder();
        let slice = |generation| Named {
            kind: "EndpointSlice".into(),
            group: "discovery.k8s.io".into(),
            uid: "slice".into(),
            name: "web-96nx5".into(),
            namespace: Some("shop".into()),
            generation: Some(generation),
            controlled: false,
        };
        recorder.named_seen(&named("pod", Some(1), true), Sight::First);
        recorder.named_seen(&slice(5), Sight::First);
        recorder.named_seen(&named("lone", Some(1), false), Sight::First);
        recorder.named_seen(&named("pod", Some(2), true), Sight::Watched);
        recorder.named_seen(&slice(6), Sight::Watched);
        recorder.named_seen(&named("lone", Some(2), false), Sight::Watched);
        let found: Vec<String> = rows(&cluster).iter().map(|row| row.name.clone()).collect();
        assert_eq!(found, ["job-lone"]);
    }

    /// Seen by name only: a moved generation is a row that says so, a birth
    /// a controller made is its owner's, and a kind that keeps no generation
    /// says nothing of a change it cannot see. Fails if any of the three is
    /// said otherwise.
    #[test]
    fn a_kind_seen_by_name_says_its_generation_and_leaves_owned_births_to_their_owner() {
        let (_t, cluster, mut recorder) = recorder();
        recorder.named_seen(&named("a", Some(1), false), Sight::First);
        recorder.named_seen(&named("b", None, false), Sight::First);
        assert!(rows(&cluster).is_empty(), "a first sight is a baseline");
        recorder.named_seen(&named("a", Some(2), false), Sight::Watched);
        recorder.named_seen(&named("b", None, false), Sight::Watched);
        recorder.named_seen(&named("c", Some(1), true), Sight::Watched);
        recorder.named_seen(&named("d", Some(1), false), Sight::Watched);
        recorder.named_gone("c", false);
        recorder.named_gone("d", false);
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

mod following {
    use super::*;
    use crate::feeds::{FeedState, Update, Whole};
    use crate::ownership::{KindKey, News, SlotKey};
    use crate::timeline::follow::{feed, hear};
    use crate::timeline::recorder::Recorder;
    use kube::api::DynamicObject;

    fn kind(group: &str, plural: &str) -> KindKey {
        KindKey {
            group: group.into(),
            plural: plural.into(),
        }
    }

    fn slot(group: &str, plural: &str) -> SlotKey {
        SlotKey {
            kind: kind(group, plural),
            namespace: None,
        }
    }

    fn object(value: Value) -> Arc<DynamicObject> {
        Arc::new(serde_json::from_value(value).expect("an object"))
    }

    fn api(image: &str) -> Arc<DynamicObject> {
        let mut value = deployment(image, 2, "v");
        value["apiVersion"] = json!("apps/v1");
        value["kind"] = json!("Deployment");
        object(value)
    }

    fn state(group: &str, plural: &str, state: FeedState) -> Update {
        Update::State {
            slot: slot(group, plural),
            state,
        }
    }

    fn whole(why: Whole, objects: Vec<Arc<DynamicObject>>) -> Update {
        Update::Whole {
            slot: slot("apps", "deployments"),
            why,
            objects,
        }
    }

    fn setup() -> (Arc<Timelines>, Arc<ClusterTimeline>, Recorder) {
        let (timelines, _rx) = holder(None, false);
        let cluster = timelines.cluster("kind");
        let recorder = Recorder::new(cluster.clone());
        (timelines, cluster, recorder)
    }

    /// A watch that broke and listed again: the span ends where the layer
    /// says it last saw, the next opens on the list, and what moved in
    /// between is said to have been noticed. Fails if the blind stretch is
    /// drawn as watched, or the change is lost or passed off as seen.
    #[test]
    fn a_break_ends_the_span_where_the_watch_went_blind_and_the_relist_says_what_moved() {
        let (_t, cluster, mut recorder) = setup();
        feed(
            &mut recorder,
            state("apps", "deployments", FeedState::Synced),
        );
        feed(&mut recorder, whole(Whole::Fresh, vec![api("nginx:1")]));
        // After the span began, whatever the date the test runs on: a fixed
        // moment fell out of the week kept and was pruned.
        let blind_at = ClusterTimeline::now();
        let blind = chrono::DateTime::from_timestamp_millis(blind_at)
            .unwrap()
            .to_rfc3339();
        feed(
            &mut recorder,
            state(
                "apps",
                "deployments",
                FeedState::Blind {
                    since: blind.clone(),
                },
            ),
        );
        feed(
            &mut recorder,
            state("apps", "deployments", FeedState::Synced),
        );
        feed(&mut recorder, whole(Whole::Relist, vec![api("nginx:2")]));
        let page = cluster.page(&query(Show::All));
        let spans = page.spans.followed;
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].to, Some(blind_at));
        assert_eq!(spans[1].to, None);
        assert_eq!(page.rows.len(), 1);
        assert!(page.rows[0].at_relist);
    }

    /// A queue that overflowed is handed the whole set again with no break
    /// in the watch: the app was watching all along. Fails if that draws a
    /// gap, or loses what moved while the updates were dropped.
    #[test]
    fn a_queue_that_overflowed_is_a_relist_and_not_a_gap() {
        let (_t, cluster, mut recorder) = setup();
        feed(
            &mut recorder,
            state("apps", "deployments", FeedState::Synced),
        );
        feed(&mut recorder, whole(Whole::Fresh, vec![api("nginx:1")]));
        feed(&mut recorder, whole(Whole::Relist, vec![api("nginx:2")]));
        let page = cluster.page(&query(Show::All));
        assert_eq!(page.spans.followed.len(), 1);
        assert_eq!(page.spans.followed[0].to, None);
        assert_eq!(page.rows.len(), 1);
        assert!(page.rows[0].at_relist);
    }

    /// A Gateway route kind the cluster does not serve is not one of the
    /// kinds. Fails if it keeps the span shut, or is named as refused.
    #[test]
    fn a_kind_the_cluster_does_not_serve_holds_nothing_shut() {
        let (_t, cluster, mut recorder) = setup();
        feed(
            &mut recorder,
            state(
                "gateway.networking.k8s.io",
                "httproutes",
                FeedState::Syncing,
            ),
        );
        feed(
            &mut recorder,
            state("apps", "deployments", FeedState::Synced),
        );
        assert!(cluster.page(&query(Show::All)).spans.followed.is_empty());
        feed(
            &mut recorder,
            state(
                "gateway.networking.k8s.io",
                "httproutes",
                FeedState::Unserved,
            ),
        );
        let spans = cluster.page(&query(Show::All)).spans.followed;
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kinds, ["Deployment"]);
        assert!(spans[0].unwatched.is_empty());
    }

    fn core_event(uid: &str, count: i32) -> Arc<DynamicObject> {
        object(json!({
            "apiVersion": "v1", "kind": "Event",
            "metadata": {"name": format!("api.{uid}"), "namespace": "shop", "uid": uid},
            "type": "Warning", "reason": "BackOff", "message": "Back-off restarting",
            "involvedObject": {"kind": "Pod", "name": "api-1", "namespace": "shop"},
            "count": count, "lastTimestamp": "2026-11-14T10:00:00Z",
        }))
    }

    /// Each series is one row, its repeats replace it, and the cluster
    /// letting it expire takes nothing back. Fails if any of the three is
    /// said otherwise.
    #[test]
    fn events_are_one_row_a_series_and_their_expiry_is_not_news() {
        let (_t, cluster, mut recorder) = setup();
        feed(
            &mut recorder,
            Update::Whole {
                slot: slot("", "events"),
                why: Whole::Fresh,
                objects: vec![core_event("e1", 1), core_event("e2", 1)],
            },
        );
        feed(
            &mut recorder,
            Update::Applied {
                slot: slot("", "events"),
                object: core_event("e1", 5),
            },
        );
        feed(
            &mut recorder,
            Update::Deleted {
                slot: slot("", "events"),
                object: core_event("e2", 1),
            },
        );
        let rows = cluster.page(&query(Show::Warnings)).rows;
        assert_eq!(rows.len(), 2);
        let counts: Vec<Option<i32>> = rows
            .iter()
            .map(|row| match &row.what {
                RowSays::Event { event } => event.count,
                _ => None,
            })
            .collect();
        assert!(counts.contains(&Some(5)) && counts.contains(&Some(1)));
    }

    fn news_of(uid: &str, generation: i64, sight: crate::ownership::Sight) -> News {
        News::Seen {
            uid: uid.into(),
            node: crate::ownership::Node {
                key: kind("batch", "jobs"),
                kind: "Job".into(),
                version: "v1".into(),
                name: format!("job-{uid}"),
                namespace: Some("shop".into()),
                owners: Vec::new(),
                generation: Some(generation),
            },
            sight,
        }
    }

    /// A kind read by its list alone whose next turn never came: the index
    /// counted it stale after ninety seconds, while the timeline went on
    /// calling the stretch watched. Fails if an overdue list does not end the
    /// name-only span, or a fresh list does not open it again.
    #[test]
    fn a_list_whose_next_turn_is_overdue_ends_the_name_only_span() {
        let (_t, cluster, mut recorder) = setup();
        let listed = |at| News::State {
            slot: SlotKey {
                kind: kind("batch", "jobs"),
                namespace: None,
            },
            state: crate::ownership::SlotState::Listed { at },
        };
        let open = |cluster: &ClusterTimeline| {
            cluster
                .page(&query(Show::All))
                .spans
                .meta
                .iter()
                .any(|span| span.to.is_none())
        };
        hear(
            &mut recorder,
            listed(chrono::Utc::now() - chrono::Duration::seconds(100)),
        );
        assert!(open(&cluster));
        recorder.overdue(ClusterTimeline::now());
        assert!(!open(&cluster), "an overdue list drawn as watched");
        hear(&mut recorder, listed(chrono::Utc::now()));
        recorder.overdue(ClusterTimeline::now());
        assert!(open(&cluster));
    }

    /// The window moved from `shop` to `ops` and back: the index stopped
    /// reading `shop`'s Jobs and read them again. Fails if a generation that
    /// moved while they were not read is said to have been seen moving, or
    /// the slot let go keeps the name-only span shut.
    #[test]
    fn a_namespace_the_index_let_go_is_a_first_sight_when_read_again() {
        use crate::ownership::SlotState::{Live, Syncing};
        let (_t, cluster, mut recorder) = setup();
        let shop = SlotKey {
            kind: kind("batch", "jobs"),
            namespace: Some("shop".into()),
        };
        let ops = SlotKey {
            namespace: Some("ops".into()),
            ..shop.clone()
        };
        let state = |slot: &SlotKey, state| News::State {
            slot: slot.clone(),
            state,
        };
        hear(&mut recorder, state(&shop, Live));
        hear(
            &mut recorder,
            news_of("j1", 1, crate::ownership::Sight::First),
        );
        hear(&mut recorder, state(&shop, Syncing));
        hear(
            &mut recorder,
            News::Dropped {
                slot: shop.clone(),
                uids: vec!["j1".into()],
            },
        );
        hear(&mut recorder, state(&ops, Live));
        let open = |cluster: &ClusterTimeline| {
            cluster
                .page(&query(Show::All))
                .spans
                .meta
                .iter()
                .any(|span| span.to.is_none())
        };
        assert!(open(&cluster), "the slot let go holds the span shut");
        hear(&mut recorder, state(&shop, Syncing));
        hear(
            &mut recorder,
            news_of("j1", 2, crate::ownership::Sight::First),
        );
        hear(&mut recorder, state(&shop, Live));
        assert!(cluster.page(&query(Show::All)).rows.is_empty());
    }

    /// What the index reads by name only has a span of its own and leaves
    /// the followed kinds to their watches. Fails if a followed kind's index
    /// slot holds the name-only span shut, or a moved generation is not a row.
    #[test]
    fn the_index_speaks_for_the_kinds_only_it_reads() {
        let (_t, cluster, mut recorder) = setup();
        hear(
            &mut recorder,
            News::State {
                slot: slot("apps", "deployments"),
                state: crate::ownership::SlotState::Syncing,
            },
        );
        hear(
            &mut recorder,
            News::State {
                slot: slot("batch", "jobs"),
                state: crate::ownership::SlotState::Live,
            },
        );
        hear(
            &mut recorder,
            news_of("a", 1, crate::ownership::Sight::First),
        );
        hear(
            &mut recorder,
            news_of("a", 2, crate::ownership::Sight::Watched),
        );
        let page = cluster.page(&query(Show::All));
        assert_eq!(page.spans.meta.len(), 1);
        assert_eq!(page.spans.meta[0].to, None);
        assert_eq!(page.rows.len(), 1);
        assert!(matches!(page.rows[0].what, RowSays::Generation { .. }));
        recorder.meta_ended();
        assert!(cluster.page(&query(Show::All)).spans.meta[0].to.is_some());
    }
}

mod listed_for_a_reader {
    use super::*;
    use crate::feeds::{FeedState, Update, Whole};
    use crate::ownership::{KindKey, SlotKey};
    use crate::timeline::follow::feed;
    use crate::timeline::recorder::Recorder;
    use kube::api::DynamicObject;

    fn slot() -> SlotKey {
        SlotKey {
            kind: KindKey {
                group: String::new(),
                plural: "configmaps".into(),
            },
            namespace: None,
        }
    }

    fn state(state: FeedState) -> Update {
        Update::State {
            slot: slot(),
            state,
        }
    }

    fn whole(why: Whole, value: &str) -> Update {
        let object: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": {"name": "app", "namespace": "shop", "uid": "u",
                "creationTimestamp": "2026-11-01T00:00:00Z"},
            "data": {"k": value},
        }))
        .expect("a ConfigMap");
        Update::Whole {
            slot: slot(),
            why,
            objects: vec![Arc::new(object)],
        }
    }

    fn setup() -> (Arc<Timelines>, Arc<ClusterTimeline>, Recorder) {
        let (timelines, _rx) = holder(None, false);
        let cluster = timelines.cluster("kind");
        let recorder = Recorder::new(cluster.clone());
        (timelines, cluster, recorder)
    }

    /// The layer keeps no `ConfigMap` or `Secret`, so a reader that fell behind
    /// is listed them again while their changes wait. The watch never broke:
    /// fails if that list draws a gap, or loses what moved meanwhile.
    #[test]
    fn a_list_for_a_reader_that_fell_behind_is_not_a_gap() {
        let (_t, cluster, mut recorder) = setup();
        feed(&mut recorder, state(FeedState::Synced));
        feed(&mut recorder, whole(Whole::Fresh, "1"));
        feed(&mut recorder, state(FeedState::Syncing));
        feed(&mut recorder, state(FeedState::Synced));
        feed(&mut recorder, whole(Whole::Relist, "2"));
        let page = cluster.page(&query(Show::All));
        assert_eq!(page.spans.followed.len(), 1, "{:?}", page.spans.followed);
        assert_eq!(page.spans.followed[0].to, None);
        assert_eq!(page.rows.len(), 1);
        assert!(page.rows[0].at_relist);
    }

    /// A list for the reader that failed leaves it holding nothing current
    /// until the retry answers. Fails if that stretch is drawn as watched,
    /// or the span does not open again with the set that follows.
    #[test]
    fn a_list_that_failed_is_not_watched_until_the_retry_answers() {
        let (_t, cluster, mut recorder) = setup();
        feed(&mut recorder, state(FeedState::Synced));
        feed(&mut recorder, whole(Whole::Fresh, "1"));
        feed(&mut recorder, state(FeedState::Syncing));
        feed(
            &mut recorder,
            state(FeedState::Failed {
                message: "timed out".into(),
            }),
        );
        let shut = cluster.page(&query(Show::All)).spans.followed;
        assert!(shut[0].to.is_some());
        feed(&mut recorder, state(FeedState::Synced));
        feed(&mut recorder, whole(Whole::Relist, "2"));
        let page = cluster.page(&query(Show::All));
        assert_eq!(page.spans.followed.len(), 2);
        assert_eq!(page.spans.followed[1].to, None);
        assert!(page.rows[0].at_relist);
    }
}
