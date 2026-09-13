import { describe, expect, it } from "vitest";

import live from "@/lib/__fixtures__/live-prometheus-alerts.json";
import type {
  AlertRule,
  CustomResourceInfo,
  NamespaceInfo,
} from "@/generated/types";
import { readPrometheus } from "../monitors/model";
import { alertsAbout, readRule, rowsOf, type RuleRow } from "./model";

/**
 * What kube-prometheus-stack wrote on a real cluster, plus three rule
 * objects written for the page: one the chart's Prometheus picks up with
 * an always-firing alert, one nothing picks up, one whose rule cannot
 * evaluate. Recorded on 2026-09-13 with `kubectl get -o json` and the
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
      alerts: 1,
      rules: 1,
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

  it("finds the Watchdog firing about nothing in particular", () => {
    const general = row("kps-kube-prometheus-stack-general.rules");
    expect(general.group).toBe("firing");
    expect(
      alertsAbout(loaded.rules, {
        kind: "Pod",
        name: "nothing",
        namespace: "monitoring",
      })
    ).toEqual([]);
  });
});
