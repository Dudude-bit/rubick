import { describe, expect, it } from "vitest";

import {
  clusterChoices,
  kindInName,
  looksLikeAlert,
  parseAlert,
} from "./alerts";

/**
 * What these messages actually look like where a person reads them.
 *
 * Every one of them is the shape a real sender renders, not an invention:
 * Alertmanager's plain-text body and its subject line, the Grafana superset
 * of that body, Datadog's tags, and an Alertmanager alert wrapped in
 * PagerDuty's own chrome.
 */
const ALERTMANAGER_TEXT = `[FIRING:1] KubePodCrashLooping (payments-7b6d9c5f4-x8k2p shop kube-prometheus-stack critical)

Alert: Pod shop/payments-7b6d9c5f4-x8k2p (payments) is in waiting state (reason: "CrashLoopBackOff").
Labels:
 - alertname = KubePodCrashLooping
 - cluster = prod-eu-1
 - container = payments
 - endpoint = http-metrics
 - job = kube-state-metrics
 - namespace = shop
 - pod = payments-7b6d9c5f4-x8k2p
 - prometheus = monitoring/kube-prometheus-stack-prometheus
 - service = kube-prometheus-stack-kube-state-metrics
 - severity = critical
Annotations:
 - description = Pod shop/payments-7b6d9c5f4-x8k2p (payments) is in waiting state (reason: "CrashLoopBackOff").
 - summary = Pod is crash looping.
Source: https://prometheus.prod-eu-1.example.com/graph?g0.expr=max_over_time%28kube_pod_container_status_waiting_reason%7Breason%3D%22CrashLoopBackOff%22%7D%5B5m%5D%29
Started: 2026-09-10 03:14:22 UTC`;

const DEPLOYMENT_TEXT = `[FIRING:1] KubeDeploymentReplicasMismatch (shop warning)
Labels:
 - alertname = KubeDeploymentReplicasMismatch
 - cluster = prod-eu-1
 - deployment = checkout
 - job = kube-state-metrics
 - namespace = shop
 - pod = kube-prometheus-stack-kube-state-metrics-7d9f8c6b5-mn2kx
 - severity = warning
Annotations:
 - description = Deployment shop/checkout has not matched the expected number of replicas for longer than 15 minutes.
Started: 2026-09-10 03:41:00 UTC`;

const VOLUME_TEXT = `[FIRING:1] KubePersistentVolumeFillingUp (shop critical)
Labels:
 - alertname = KubePersistentVolumeFillingUp
 - namespace = shop
 - persistentvolumeclaim = data-postgres-0
 - severity = critical
Annotations:
 - description = The PersistentVolume claimed by data-postgres-0 in Namespace shop is only 3.28% free.
Source: https://prometheus.prod-eu-1.example.com/graph?g0.expr=kubelet_volume_stats
Started: 2026-09-10 02:02:11 UTC`;

const SUBJECT_ONLY = `[FIRING:1] KubePodCrashLooping (payments-7b6d9c5f4-x8k2p shop kube-prometheus-stack critical)`;

const GRAFANA = `[Alerting] Search indexer lag
Value: B=482
Labels:
 - alertname = Search indexer lag
 - namespace = search
 - job = search-indexer
Annotations:
 - summary = The search indexer is 482 documents behind.
Silence: https://grafana.example.com/alerting/silence/new
Dashboard: https://grafana.example.com/d/abc
Panel: https://grafana.example.com/d/abc?viewPanel=4
Fired at: 2026-09-10 02:58:03 UTC`;

const DATADOG = `[Triggered on {kube_namespace:shop,pod_name:payments-7b6d9c5f4-x8k2p}] Pod is restarting

pod payments-7b6d9c5f4-x8k2p is in CrashloopBackOff on shop

kube_cluster_name:prod-eu-1
kube_namespace:shop
pod_name:payments-7b6d9c5f4-x8k2p
kube_container_name:payments
@slack-oncall`;

const PAGERDUTY_WRAPPED = `PagerDuty Alert: Incident #4821 Triggered: KubeStatefulSetReplicasMismatch on prod-eu-1
Service: Kubernetes production
Details:
Labels:
 - alertname = KubeStatefulSetReplicasMismatch
 - namespace = shop
 - statefulset = postgres
 - severity = critical
Annotations:
 - description = StatefulSet shop/postgres has not matched the expected number of replicas for longer than 15 minutes.
Started: 2026-09-10 03:22:00 UTC`;

describe("recognising a paste as an alert", () => {
  it("reads the marks the senders actually put in the text", () => {
    for (const text of [
      ALERTMANAGER_TEXT,
      SUBJECT_ONLY,
      GRAFANA,
      DATADOG,
      PAGERDUTY_WRAPPED,
    ]) {
      expect(looksLikeAlert(text)).toBe(true);
    }
  });

  /**
   * The box a person types names into all day. Turning an ordinary search
   * into an alert panel would be worse than never offering the panel.
   */
  it("leaves an ordinary search alone", () => {
    for (const text of [
      "payments",
      "payments-7b6d9c5f4-x8k2p",
      "shop/checkout",
      "!prod-eu-1 payments",
      "namespace",
    ]) {
      expect(looksLikeAlert(text)).toBe(false);
      expect(parseAlert(text)).toBeNull();
    }
  });
});

describe("an Alertmanager body", () => {
  const read = parseAlert(ALERTMANAGER_TEXT)!;

  it("takes every field from a key it can name", () => {
    expect(read.alertName).toBe("KubePodCrashLooping");
    expect(read.severity).toBe("critical");
    expect(read.cluster).toEqual({
      value: "prod-eu-1",
      from: { how: "key", key: "cluster" },
    });
    expect(read.namespace).toEqual({
      value: "shop",
      from: { how: "key", key: "namespace" },
    });
    expect(read.container).toEqual({
      value: "payments",
      from: { how: "key", key: "container" },
    });
    expect(read.objects[0]).toMatchObject({
      kind: "Pod",
      name: "payments-7b6d9c5f4-x8k2p",
      role: "subject",
    });
  });

  it("dates the alert from the line that dates it", () => {
    expect(read.firedAt?.value).toBe(Date.parse("2026-09-10T03:14:22Z"));
  });

  it("quotes the rule author's sentence rather than composing one", () => {
    expect(read.claim).toBe(
      'Pod shop/payments-7b6d9c5f4-x8k2p (payments) is in waiting state (reason: "CrashLoopBackOff").'
    );
  });

  /**
   * The trap on every alert this stack sends. `job = kube-state-metrics` is
   * a Prometheus scrape job, and the Kubernetes Job is `job_name`; reading
   * the first as the second opens an object that does not exist, every time.
   */
  it("never reads a Prometheus job as a Kubernetes Job", () => {
    expect(read.objects.some((object) => object.kind === "Job")).toBe(false);
    expect(read.ignored).toContain("job");
    expect(read.ignored).toContain("endpoint");
    expect(read.ignored).toContain("prometheus");
    expect(read.ignored).toContain("service");
  });
});

describe("which object the alert is about", () => {
  /**
   * A `KubeDeploymentReplicasMismatch` carries a `pod` label, and that pod is
   * kube-state-metrics. Opening it would send a person to read the logs of
   * the monitoring stack while their checkout is down.
   */
  it("follows the alert's own name past a pod that belongs to the metrics", () => {
    const read = parseAlert(DEPLOYMENT_TEXT)!;
    expect(read.objects[0]).toMatchObject({
      kind: "Deployment",
      name: "checkout",
      role: "subject",
      from: { how: "alertName" },
    });
    expect(read.objects[1]).toMatchObject({
      kind: "Pod",
      name: "kube-prometheus-stack-kube-state-metrics-7d9f8c6b5-mn2kx",
      role: "alsoNamed",
    });
  });

  /**
   * `KubePersistentVolumeFillingUp` is named for a volume and labelled with a
   * claim. A preference nothing satisfies has to fall through, or the alert
   * with the most urgent name of all opens nothing.
   */
  it("falls through to what the alert really carries when the name asks for what it does not", () => {
    const read = parseAlert(VOLUME_TEXT)!;
    expect(read.objects[0]).toMatchObject({
      kind: "PersistentVolumeClaim",
      name: "data-postgres-0",
      role: "subject",
      from: { how: "key", key: "persistentvolumeclaim" },
    });
  });

  it("reads the kind out of the names the mixin uses", () => {
    expect(kindInName("KubeletTooManyPods")).toBe("Node");
    expect(kindInName("KubePodNotReady")).toBe("Pod");
    expect(kindInName("KubeStatefulSetReplicasMismatch")).toBe("StatefulSet");
    expect(kindInName("KubeDaemonSetRolloutStuck")).toBe("DaemonSet");
    expect(kindInName("KubeHpaMaxedOut")).toBe("HorizontalPodAutoscaler");
    expect(kindInName("KubePdbNotEnoughHealthyPods")).toBe(
      "PodDisruptionBudget"
    );
    expect(kindInName("KubeJobFailed")).toBe("Job");
    expect(kindInName("Search indexer lag")).toBeNull();
  });
});

describe("a subject line on its own", () => {
  const read = parseAlert(SUBJECT_ONLY)!;

  /**
   * Alertmanager's subject template joins the extra labels as values with the
   * keys thrown away, and the short Telegram templates people write send
   * exactly this one line. Anything recognised here is recognised by shape,
   * and has to say so rather than borrow a key it never had.
   */
  it("says what it recognised by shape, and does not pretend to a key", () => {
    expect(read.format).toBe("alertmanagerSubject");
    expect(read.alertName).toBe("KubePodCrashLooping");
    expect(read.objects[0]).toEqual({
      kind: "Pod",
      name: "payments-7b6d9c5f4-x8k2p",
      from: { how: "shape", says: "podName" },
      role: "subject",
    });
  });

  it("leaves the values it cannot place as candidates rather than fields", () => {
    expect(read.namespace).toBeNull();
    expect(read.unkeyed).toEqual(["shop", "kube-prometheus-stack"]);
  });

  it("names no cluster where the line carries none", () => {
    expect(read.cluster).toBeNull();
  });
});

describe("the other senders", () => {
  it("reads Grafana's body, which is Alertmanager's with more lines", () => {
    const read = parseAlert(GRAFANA)!;
    expect(read.format).toBe("grafana");
    expect(read.alertName).toBe("Search indexer lag");
    expect(read.namespace?.value).toBe("search");
    expect(read.firedAt?.value).toBe(Date.parse("2026-09-10T02:58:03Z"));
    // `job = search-indexer` is a Prometheus job here too, and this alert
    // names no Kubernetes object at all. Saying so is the honest answer.
    expect(read.objects).toEqual([]);
    expect(read.ignored).toContain("job");
  });

  it("reads Datadog's tags as the same facts under other keys", () => {
    const read = parseAlert(DATADOG)!;
    expect(read.format).toBe("datadog");
    expect(read.cluster?.value).toBe("prod-eu-1");
    expect(read.namespace?.value).toBe("shop");
    expect(read.container?.value).toBe("payments");
    expect(read.objects[0]).toMatchObject({
      kind: "Pod",
      name: "payments-7b6d9c5f4-x8k2p",
    });
  });

  /**
   * PagerDuty is a wrapper: its own text carries an incident number and a
   * service name, and the Kubernetes identity sits in the description it was
   * handed. Reading what is inside beats pretending to know a fourth format.
   */
  it("reads an alert through the chrome somebody wrapped it in", () => {
    const read = parseAlert(PAGERDUTY_WRAPPED)!;
    expect(read.alertName).toBe("KubeStatefulSetReplicasMismatch");
    expect(read.namespace?.value).toBe("shop");
    expect(read.objects[0]).toMatchObject({
      kind: "StatefulSet",
      name: "postgres",
      role: "subject",
    });
  });
});

describe("the cluster, when no label names one", () => {
  /**
   * The environment is in the Prometheus hostname often enough to offer and
   * never often enough to assume, so it arrives marked as coming from a URL.
   */
  it("offers the Source host as a guess, and says it is one", () => {
    const read = parseAlert(VOLUME_TEXT)!;
    expect(read.cluster).toEqual({
      value: "prometheus.prod-eu-1.example.com",
      from: { how: "sourceHost", host: "prometheus.prod-eu-1.example.com" },
    });
  });

  /**
   * A bare `03:14 UTC` would have to be dated by guessing a day, and a window
   * opened on the wrong day shows a calm hour that reads as "nothing
   * happened".
   */
  it("refuses a time with no date rather than guessing the day", () => {
    const read = parseAlert(`[FIRING:1] KubePodCrashLooping (shop critical)
Labels:
 - alertname = KubePodCrashLooping
 - namespace = shop
Started: 03:14 UTC`)!;
    expect(read.firedAt).toBeNull();
  });
});

describe("which of your clusters it meant", () => {
  const named = (value: string) => ({
    cluster: { value, from: { how: "key" as const, key: "cluster" } },
  });

  it("settles only on a name this kubeconfig really has", () => {
    const { settled, choices } = clusterChoices(named("prod-eu-1"), [
      "prod-eu-1",
      "staging",
    ]);
    expect(settled).toBe("prod-eu-1");
    expect(choices).toEqual([]);
  });

  /**
   * A label naming a cluster this kubeconfig does not have is not an answer,
   * however confident it sounds. Two near names are worse: picking one sends
   * a person to read a healthy copy of the thing that is down.
   */
  it("asks when the name is close to more than one of yours", () => {
    const { settled, choices } = clusterChoices(named("prod"), [
      "prod-eu-1",
      "prod-us-1",
      "staging",
    ]);
    expect(settled).toBeNull();
    expect(choices.map((choice) => choice.context)).toEqual([
      "prod-eu-1",
      "prod-us-1",
    ]);
    expect(choices[0].why).toBe("nameAppearsInIt");
  });

  it("offers the cluster whose name is in the Source host", () => {
    const { choices } = clusterChoices(
      {
        cluster: {
          value: "prometheus.prod-eu-1.example.com",
          from: {
            how: "sourceHost",
            host: "prometheus.prod-eu-1.example.com",
          },
        },
      },
      ["prod-eu-1", "staging"]
    );
    expect(choices).toEqual([{ context: "prod-eu-1", why: "inTheSourceHost" }]);
  });

  it("falls back to every cluster you have when the alert names none", () => {
    const { settled, choices } = clusterChoices({ cluster: null }, [
      "prod-eu-1",
      "staging",
    ]);
    expect(settled).toBeNull();
    expect(choices.every((choice) => choice.why === "yoursToPick")).toBe(true);
  });
});
