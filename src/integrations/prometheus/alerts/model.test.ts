import { describe, expect, it } from "vitest";

import type { AlertRule, CustomResourceInfo } from "@/generated/types";
import {
  readPrometheus,
  type Kind,
  type PrometheusInstance,
} from "../monitors/model";
import {
  alertsAbout,
  findingsOf,
  groupOf,
  loadedOf,
  ownsFile,
  readRule,
  rowsOf,
  rulePickedUpBy,
} from "./model";

const cr = (
  kind: string,
  name: string,
  namespace: string,
  spec: unknown,
  labels: Record<string, string> = {}
): CustomResourceInfo => ({
  name,
  namespace,
  uid: `${namespace}/${kind}/${name}`,
  apiVersion: "monitoring.coreos.com/v1",
  kind,
  spec,
  status: null,
  labels,
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: 1,
});

const ruleObject = (name = "apps", namespace = "monitoring") =>
  readRule(
    cr(
      "PrometheusRule",
      name,
      namespace,
      {
        groups: [
          {
            name: "kubernetes-apps",
            rules: [
              {
                alert: "KubePodCrashLooping",
                expr: "max_over_time(kube_pod_container_status_waiting_reason[5m]) >= 1",
                for: "15m",
                labels: { severity: "warning" },
                annotations: { summary: "Pod is crash looping." },
              },
              { record: "cluster:cpu", expr: "sum(rate(cpu[5m]))" },
              {
                alert: "KubeDeploymentReplicasMismatch",
                expr: "kube_deployment_spec_replicas != kube_deployment_status_replicas_available",
              },
            ],
          },
        ],
      },
      { release: "kps" }
    )
  );

const apiRule = (over: Partial<AlertRule> = {}): AlertRule => ({
  group: "kubernetes-apps",
  file: "/etc/prometheus/rules/prometheus-kps-rulefiles-0/monitoring-apps-monitoring/PrometheusRule/apps.yaml",
  name: "KubePodCrashLooping",
  state: "inactive",
  health: "ok",
  lastError: "",
  query: "max_over_time(...) >= 1",
  durationSeconds: 900,
  lastEvaluation: null,
  labels: { severity: "warning" },
  annotations: {},
  alerts: [],
  ...over,
});

const kind = (items: PrometheusInstance[]): Kind<PrometheusInstance> => ({
  state: "read",
  items,
});

describe("readRule", () => {
  it("keeps the alerting rules with their group and counts the recording ones apart", () => {
    const object = ruleObject();
    expect(object.rules.map((r) => r.alert)).toEqual([
      "KubePodCrashLooping",
      "KubeDeploymentReplicasMismatch",
    ]);
    expect(object.rules[0]).toMatchObject({
      group: "kubernetes-apps",
      for: "15m",
      labels: { severity: "warning" },
    });
    expect(object.recording).toBe(1);
  });
});

describe("rulePickedUpBy", () => {
  const prom = (spec: unknown) =>
    readPrometheus(cr("Prometheus", "k8s", "monitoring", spec));

  /** The chart's default: `ruleSelector` by release, every namespace. A missing ruleSelector picks nothing. */
  it("reads the rule selectors with the monitors' absent-versus-empty rule", () => {
    const object = ruleObject("apps", "shop");
    const byRelease = prom({
      ruleSelector: { matchLabels: { release: "kps" } },
      ruleNamespaceSelector: {},
    });
    const none = prom({ ruleNamespaceSelector: {} });
    const ownNamespace = prom({ ruleSelector: {} });
    expect(
      rulePickedUpBy(object, kind([byRelease]), { ok: true, items: [] })
    ).toEqual({
      state: "judged",
      by: ["k8s"],
    });
    expect(
      rulePickedUpBy(object, kind([none]), { ok: true, items: [] })
    ).toEqual({
      state: "judged",
      by: [],
    });
    expect(
      rulePickedUpBy(object, kind([ownNamespace]), { ok: true, items: [] })
    ).toEqual({
      state: "judged",
      by: [],
    });
  });
});

describe("loadedOf", () => {
  const object = ruleObject();

  /** The operator names the file after the object, with or without the uid; anything else is another object's. */
  it("finds the object's rules by the file the operator named after it", () => {
    const named = { ...object, uid: "1a2b3c4d-0000-4000-8000-000000000001" };
    expect(ownsFile(named, "/rules/x/monitoring-apps.yaml")).toBe(true);
    expect(ownsFile(named, `/rules/x/monitoring-apps-${named.uid}.yaml`)).toBe(
      true
    );
    expect(ownsFile(named, "/rules/x/monitoring-apps-extra.yaml")).toBe(false);
    expect(ownsFile(named, "/rules/x/shop-apps.yaml")).toBe(false);
  });

  it("pairs each rule with what Prometheus has, and says which are missing", () => {
    const read = loadedOf(object, {
      state: "read",
      rules: [
        apiRule({ file: "/rules/monitoring-apps.yaml", state: "firing" }),
        apiRule({
          file: "/rules/shop-other.yaml",
          name: "KubeDeploymentReplicasMismatch",
        }),
      ],
    });
    expect(read.state).toBe("read");
    if (read.state !== "read") return;
    expect(read.files).toEqual(["/rules/monitoring-apps.yaml"]);
    expect(read.rules.map((r) => r.loaded?.state ?? null)).toEqual([
      "firing",
      null,
    ]);
  });

  it("passes the other two states through untouched", () => {
    expect(loadedOf(object, { state: "notConnected" })).toEqual({
      state: "notConnected",
    });
    expect(loadedOf(object, { state: "unanswered", reason: "403" })).toEqual({
      state: "unanswered",
      reason: "403",
    });
  });
});

describe("rowsOf", () => {
  const object = ruleObject();
  const prom = readPrometheus(
    cr("Prometheus", "k8s", "monitoring", {
      ruleSelector: {},
      ruleNamespaceSelector: {},
    })
  );
  const namespaces = { ok: true as const, items: [] };
  const alert = (state: string, pod: string) => ({
    state,
    activeAt: "2026-09-12T20:00:00Z",
    value: "1",
    labels: { namespace: "shop", pod, severity: "warning" },
    annotations: { summary: `Pod shop/${pod} is crash looping.` },
  });

  /** Firing outranks a broken sibling rule: the alert is what the reader came for. */
  it("puts firing first, then broken, then pending, and names the worst finding", () => {
    const rules = [
      apiRule({
        file: "/rules/monitoring-apps.yaml",
        state: "firing",
        alerts: [alert("firing", "web-1"), alert("firing", "web-2")],
      }),
      apiRule({
        file: "/rules/monitoring-apps.yaml",
        name: "KubeDeploymentReplicasMismatch",
        health: "err",
        lastError: "found duplicate series",
      }),
    ];
    const [row] = rowsOf([object], kind([prom]), namespaces, {
      state: "read",
      rules,
    });
    expect(row.group).toBe("firing");
    expect(row.findings.map((f) => f.kind)).toEqual(["firing", "evalError"]);
    expect(row.findings[0]).toMatchObject({ alerts: 2, rules: 1 });
  });

  /**
   * Picked up and yet no file in Prometheus: the operator has not written
   * it, or wrote it elsewhere. Would break if an unread rule list were
   * mapped to "loaded nothing", or if not-loaded were raised on top of
   * "nobody picks it up".
   */
  it("says not loaded only when something is known to pick the object up", () => {
    const [pickedUp] = rowsOf([object], kind([prom]), namespaces, {
      state: "read",
      rules: [],
    });
    expect(pickedUp.findings.map((f) => f.kind)).toEqual(["notLoaded"]);
    expect(pickedUp.group).toBe("broken");
    const nobody = readPrometheus(cr("Prometheus", "k8s", "monitoring", {}));
    const [unpicked] = rowsOf([object], kind([nobody]), namespaces, {
      state: "read",
      rules: [],
    });
    expect(unpicked.findings.map((f) => f.kind)).toEqual(["notPickedUp"]);
    const [unread] = rowsOf(
      [object],
      { state: "unread", reason: "forbidden" },
      namespaces,
      {
        state: "notConnected",
      }
    );
    expect(unread.findings.map((f) => f.kind)).toEqual(["pickedUpUnknown"]);
    expect(unread.group).toBe("unchecked");
  });

  it("is quiet when everything is loaded and nothing is active, and pending when only pending", () => {
    const loaded = [
      apiRule({ file: "/rules/monitoring-apps.yaml" }),
      apiRule({
        file: "/rules/monitoring-apps.yaml",
        name: "KubeDeploymentReplicasMismatch",
      }),
    ];
    const [quiet] = rowsOf([object], kind([prom]), namespaces, {
      state: "read",
      rules: loaded,
    });
    expect(quiet.findings).toEqual([]);
    expect(quiet.group).toBe("quiet");
    const [pending] = rowsOf([object], kind([prom]), namespaces, {
      state: "read",
      rules: [
        apiRule({
          file: "/rules/monitoring-apps.yaml",
          state: "pending",
          alerts: [alert("pending", "web-1")],
        }),
        loaded[1],
      ],
    });
    expect(pending.group).toBe("pending");
    expect(
      groupOf(
        findingsOf(
          object,
          { state: "judged", by: ["k8s"] },
          { state: "notConnected" }
        ),
        { state: "notConnected" }
      )
    ).toBe("unchecked");
  });
});

describe("alertsAbout", () => {
  const rules: AlertRule[] = [
    apiRule({
      state: "firing",
      alerts: [
        {
          state: "firing",
          activeAt: "2026-09-12T20:00:00Z",
          value: "1",
          labels: {
            namespace: "shop",
            pod: "web-7f4d9c6b5-abcde",
            severity: "warning",
          },
          annotations: {
            summary: "Pod shop/web-7f4d9c6b5-abcde is crash looping.",
          },
        },
        {
          state: "firing",
          activeAt: null,
          value: "1",
          labels: { namespace: "pay", pod: "web-7f4d9c6b5-zzzzz" },
          annotations: {},
        },
      ],
    }),
    apiRule({
      name: "KubeDeploymentReplicasMismatch",
      state: "pending",
      alerts: [
        {
          state: "pending",
          activeAt: null,
          value: "1",
          labels: { namespace: "shop", deployment: "web" },
          annotations: {},
        },
      ],
    }),
    apiRule({
      name: "KubeNodeNotReady",
      state: "firing",
      alerts: [
        {
          state: "firing",
          activeAt: null,
          value: "1",
          labels: { node: "agent-0" },
          annotations: {},
        },
      ],
    }),
  ];

  /** The label kube-state-metrics writes for the kind, in the object's namespace; a pod of the workload counts, and says so. */
  it("names the alerts about an object by its own label, and a workload's pods by their name", () => {
    const pod = alertsAbout(rules, {
      kind: "Pod",
      name: "web-7f4d9c6b5-abcde",
      namespace: "shop",
    });
    expect(pod.map((a) => [a.rule, a.state, a.via.label])).toEqual([
      ["KubePodCrashLooping", "firing", "pod"],
    ]);
    expect(pod[0].summary).toContain("crash looping");
    const deployment = alertsAbout(rules, {
      kind: "Deployment",
      name: "web",
      namespace: "shop",
    });
    expect(deployment.map((a) => [a.rule, a.via.label, a.via.value])).toEqual([
      ["KubePodCrashLooping", "pod", "web-7f4d9c6b5-abcde"],
      ["KubeDeploymentReplicasMismatch", "deployment", "web"],
    ]);
    expect(
      alertsAbout(rules, {
        kind: "Deployment",
        name: "web",
        namespace: "other",
      })
    ).toEqual([]);
    expect(
      alertsAbout(rules, { kind: "Node", name: "agent-0", namespace: null })
    ).toHaveLength(1);
    expect(
      alertsAbout(rules, {
        kind: "StatefulSet",
        name: "web",
        namespace: "shop",
      })
    ).toEqual([]);
  });
});
