import { describe, expect, it } from "vite-plus/test";

import live from "@/lib/__fixtures__/live-prometheus-alerts.json";
import type {
  AlertRule,
  CustomResourceInfo,
  NamespaceInfo,
} from "@/generated/types";
import { readPrometheus } from "../monitors/model";
import {
  alertsAbout,
  readRule,
  rowsOf,
  speaksOf,
  subjectOf,
  type RuleRow,
} from "./model";

/**
 * What kube-prometheus-stack wrote on a real cluster, plus three rule
 * objects written for the page: one the chart's Prometheus picks up with
 * an always-firing alert and a crash-loop alert about a pod written to
 * crash, one nothing picks up, one whose rule cannot evaluate. Recorded on 2026-09-13 with `kubectl get -o json` and the
 * Prometheus `/api/v1/rules` (see `recordedAt` and `cluster` in the
 * fixture); the shapes are the operator's and Prometheus's, not ours.
 */
const objects = (live.rules as unknown as CustomResourceInfo[]).map(readRule);
const instances = {
  state: "read" as const,
  items: (live.prometheuses as unknown as CustomResourceInfo[]).map(
    readPrometheus
  ),
};
const namespaces = {
  ok: true as const,
  items: live.namespaces as unknown as NamespaceInfo[],
};
const loaded = {
  state: "read" as const,
  rules: live.alertRules as unknown as AlertRule[],
};
const rows = rowsOf(objects, instances, namespaces, loaded);
const row = (name: string): RuleRow => {
  const found = rows.find((r) => r.object.name === name);
  if (!found) throw new Error(`${name} is not in the fixture`);
  return found;
};

/** The recording with one loaded rule made to fire about a claim; the fixture itself is not touched. */
const firingNth = (name: string, nth: number): AlertRule[] => {
  let seen = 0;
  return loaded.rules.map((rule) =>
    rule.name === name && seen++ === nth
      ? {
          ...rule,
          state: "firing",
          alerts: [
            {
              state: "firing",
              activeAt: null,
              value: "1",
              labels: {
                alertname: name,
                namespace: "shop",
                persistentvolumeclaim: "data-0",
                severity: rule.labels.severity,
              },
              annotations: {},
            },
          ],
        }
      : rule
  );
};
const rowWith = (rules: AlertRule[], name: string): RuleRow =>
  rowsOf(objects, instances, namespaces, { state: "read", rules }).find(
    (r) => r.object.name === name
  )!;

describe("rules the chart writes twice under one name", () => {
  /**
   * The chart has fourteen alert names that occur more than once in one
   * group. Fails if any loaded rule is read by two specs, which is what
   * pairing by name did to every one of them.
   */
  it("reads each loaded rule of the recording for one spec, the one with its labels", () => {
    let namesakes = 0;
    for (const r of rows) {
      if (r.loaded.state !== "read") continue;
      const paired = r.loaded.rules.filter((x) => x.loaded !== null);
      expect(new Set(paired.map((x) => x.loaded)).size, r.object.name).toBe(
        paired.length
      );
      for (const x of paired)
        expect(x.loaded!.labels, x.spec.alert).toEqual(x.spec.labels);
      const names = paired.map((x) => `${x.spec.group}/${x.spec.alert}`);
      namesakes += names.length - new Set(names).size;
    }
    expect(namesakes).toBeGreaterThanOrEqual(14);
  });

  /**
   * KubePersistentVolumeFillingUp is critical first, warning second, and a
   * volume four days from full fires the warning alone. The tab read the
   * critical rule for both and filed the object under Quiet while the
   * claim's own page counted one alert. Fails if the two disagree again.
   */
  it("files the object under firing when only the second rule of the name fires, as the claim's page does", () => {
    const rules = firingNth("KubePersistentVolumeFillingUp", 1);
    const storage = rowWith(
      rules,
      "kps-kube-prometheus-stack-kubernetes-storage"
    );
    expect(storage.group).toBe("firing");
    expect(storage.findings[0]).toMatchObject({
      kind: "firing",
      alerts: 1,
      rules: 1,
    });
    expect(
      alertsAbout(rules, {
        kind: "PersistentVolumeClaim",
        name: "data-0",
        namespace: "shop",
      })
    ).toHaveLength(1);
  });

  /** NodeFilesystemAlmostOutOfSpace is warning first: one firing alert was counted for both specs. */
  it("counts one firing alert once when the first rule of the name fires", () => {
    const node = rowWith(
      firingNth("NodeFilesystemAlmostOutOfSpace", 0),
      "kps-kube-prometheus-stack-node-exporter"
    );
    expect(node.findings[0]).toMatchObject({
      kind: "firing",
      alerts: 1,
      rules: 1,
    });
  });
});

describe("what the chart's kube-state-metrics alerts are about", () => {
  /**
   * Recorded: the crashing pod's own `pod` and `container` beside the
   * exporter's `service`, `endpoint` and `instance`. This is what shows the
   * scrape keeps the exporter's labels wherever the metric has none.
   */
  it("reads the recorded crash-loop alert as the crashing pod, not the exporter's Service", () => {
    const [alert] = loaded.rules.find(
      (r) => r.name === "ShopPodCrashLooping"
    )!.alerts;
    expect(alert.labels.service).toBe("kps-kube-state-metrics");
    expect(subjectOf(alert.labels)).toEqual({
      kind: "Pod",
      name: "crash-demo",
      namespace: "k8s-gui-test",
    });
  });

  /**
   * An alert on a `kube_<kind>_*` family carries that kind's label and, the
   * family having no pod label, the exporter's pod. Fails if the chart's
   * rules query a family whose kind the table lacks: its alerts would name
   * the kube-state-metrics pod.
   */
  it("knows the label of every kind the chart's rules query", () => {
    const families = new Set(
      loaded.rules.flatMap((rule) =>
        [...rule.query.matchAll(/\bkube_([a-z]+)[_{]/g)].map((m) => m[1])
      )
    );
    // `kube_state_metrics_*` is the exporter about itself.
    families.delete("state");
    expect(families.size).toBeGreaterThan(8);
    const known = [
      "Pod",
      "Node",
      "Job",
      "Deployment",
      "StatefulSet",
      "DaemonSet",
      "HorizontalPodAutoscaler",
      "PersistentVolumeClaim",
      "PersistentVolume",
      "PodDisruptionBudget",
      "ResourceQuota",
    ].filter(speaksOf);
    expect([...families].sort()).toEqual(
      known.map((kind) => kind.toLowerCase()).sort()
    );
  });
});

describe("the chart's rule objects", () => {
  /** The chart's Prometheus selects by `release: kps` in every namespace, and every chart object carries that label. */
  it("sees every chart object picked up by the chart's Prometheus", () => {
    const chart = rows.filter((r) => r.object.name.startsWith("kps-"));
    expect(chart.length).toBeGreaterThan(20);
    for (const r of chart)
      expect(r.pickedUp, r.object.name).toEqual({
        state: "judged",
        by: ["kps-kube-prometheus-stack-prometheus"],
      });
  });

  /**
   * v0.85 names the rule file `<namespace>-<name>-<uid>.yaml`. Would break
   * if `ownsFile` stopped accepting the uid spelling: every object would
   * read as not loaded against a Prometheus that has all of them.
   */
  it("finds every picked-up object's rules by the file the operator named after it", () => {
    const pickedUp = rows.filter(
      (r) =>
        r.pickedUp.state === "judged" &&
        r.pickedUp.by.length > 0 &&
        r.object.rules.length > 0
    );
    expect(pickedUp.length).toBeGreaterThan(20);
    for (const r of pickedUp) {
      expect(r.loaded.state, r.object.name).toBe("read");
      if (r.loaded.state !== "read") continue;
      expect(r.loaded.files.length, r.object.name).toBeGreaterThan(0);
      expect(
        r.loaded.rules
          .filter((x) => x.loaded === null)
          .map((x) => x.spec.alert),
        r.object.name
      ).toEqual([]);
    }
  });

  /**
   * `/api/v1/rules?type=alert` lists no group made of recording rules only,
   * so an object like `k8s.rules.container-cpu-usage-seconds` has no file
   * there and nothing wrong with it. Would break if "no file" became a
   * finding for an object with no alerting rule to load.
   */
  it("does not call a recording-only object not loaded", () => {
    const recording = row(
      "kps-kube-prometheus-stack-k8s.rules.container-cpu-usage-seconds"
    );
    expect(recording.object.rules).toEqual([]);
    expect(recording.object.recording).toBeGreaterThan(0);
    expect(recording.findings).toEqual([]);
    expect(recording.group).toBe("quiet");
  });

  it("puts the object with a firing alert first, and names the alert", () => {
    const shop = row("shop-alerts");
    expect(shop.group).toBe("firing");
    expect(shop.findings[0]).toMatchObject({
      kind: "firing",
      alerts: 2,
      rules: 2,
    });
    expect(shop.object.recording).toBe(1);
    expect(rows[0].group).toBe("firing");
  });

  /** The one without the chart's label is selected by nobody, and the page says that rather than "not loaded". */
  it("calls the object nothing selects not picked up, once", () => {
    const orphan = row("nobody-picks-up-rules");
    expect(orphan.pickedUp).toEqual({ state: "judged", by: [] });
    expect(orphan.findings.map((f) => f.kind)).toEqual(["notPickedUp"]);
    expect(orphan.group).toBe("broken");
  });

  it("carries an evaluation error in Prometheus's own words", () => {
    const broken = row("broken-rules");
    expect(broken.group).toBe("broken");
    expect(broken.findings[0]).toMatchObject({
      kind: "evalError",
      rule: "DuplicateLabelset",
    });
    expect((broken.findings[0] as { lastError: string }).lastError).toContain(
      "same labelset"
    );
  });

  /**
   * The crashing pod is named by the test object's alert and by the chart's,
   * both through the `pod` label, and by nothing in another namespace. The
   * Watchdog fires about no object at all. Breaks if the label table loses
   * `Pod` or the namespace stops being matched.
   */
  it("names the alerts about a crashing pod by the label they carry, and none about a pod nothing names", () => {
    const about = alertsAbout(loaded.rules, {
      kind: "Pod",
      name: "crash-demo",
      namespace: "k8s-gui-test",
    });
    expect(about.find((a) => a.rule === "ShopPodCrashLooping")).toMatchObject({
      state: "firing",
      severity: "critical",
      via: { label: "pod", value: "crash-demo" },
    });
    expect(about.map((a) => a.rule)).toContain("KubePodCrashLooping");
    expect(
      alertsAbout(loaded.rules, {
        kind: "Pod",
        name: "crash-demo",
        namespace: "monitoring",
      })
    ).toEqual([]);
    expect(row("kps-kube-prometheus-stack-general.rules").group).toBe("firing");
    expect(
      alertsAbout(loaded.rules, {
        kind: "Pod",
        name: "nothing",
        namespace: "monitoring",
      })
    ).toEqual([]);
  });
});
