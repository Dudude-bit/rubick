import { describe, expect, it } from "vitest";

import live from "@/lib/__fixtures__/live-prometheus-operator.json";
import type {
  CustomResourceInfo,
  NamespaceInfo,
  ScrapeTarget,
  ServiceInfo,
} from "@/generated/types";
import {
  readMonitor,
  readPrometheus,
  rowsOf,
  type MonitorKind,
  type MonitorRow,
  type TargetsRead,
} from "./model";

/**
 * What kube-prometheus-stack wrote on a real cluster, read the way the page
 * reads it. Recorded with `kubectl get ... -o json` and the Prometheus
 * `/api/v1/targets` on 2026-09-11 (see `recordedAt` and `cluster` in the
 * fixture); the shapes are the operator's, not ours.
 */
const monitors = (live.monitors as unknown as CustomResourceInfo[]).map((cr) =>
  readMonitor(cr, cr.kind as MonitorKind)
);
const instances = (live.prometheuses as unknown as CustomResourceInfo[]).map(
  readPrometheus
);
const services = {
  ok: true as const,
  items: live.services as unknown as ServiceInfo[],
};
const namespaces = {
  ok: true as const,
  items: live.namespaces as unknown as NamespaceInfo[],
};
const targets: TargetsRead = {
  state: "read",
  targets: live.targets as unknown as ScrapeTarget[],
};
const rows = rowsOf(monitors, instances, services, namespaces, targets);
const row = (name: string): MonitorRow => {
  const found = rows.find((r) => r.monitor.name === name);
  if (!found) throw new Error(`${name} is not in the fixture`);
  return found;
};

describe("the chart's own objects", () => {
  it("reads the Prometheus instance the operator runs", () => {
    expect(instances).toHaveLength(1);
    const [prom] = instances;
    expect(prom.name).toBe("kps-kube-prometheus-stack-prometheus");
    expect(prom.replicas).toBe(1);
    expect(prom.available).toBe(1);
    expect(prom.version).toBe("v3.14.0-distroless");
    expect(prom.retention).toBe("2h");
    expect(prom.reconciled?.status).toBe("True");
    expect(prom.availableCondition?.status).toBe("True");
  });

  /** With `serviceMonitorSelectorNilUsesHelmValues=false` the chart's Prometheus selects every monitor in every namespace, and the page must say so even for the specimen named to contradict it. */
  it("sees every monitor picked up by the chart's Prometheus", () => {
    expect(rows).toHaveLength(16);
    for (const r of rows) {
      expect(r.pickedUp, r.monitor.name).toEqual({
        known: true,
        by: ["kps-kube-prometheus-stack-prometheus"],
      });
    }
  });

  it("ranks the broken monitors first, the warnings next, the healthy last", () => {
    const worst = rows.map((r) => r.worst);
    const firstWarn = worst.indexOf("warn");
    const firstOk = worst.indexOf(null);
    expect(worst.lastIndexOf("err")).toBeLessThan(firstWarn);
    expect(worst.lastIndexOf("warn")).toBeLessThan(firstOk);
  });

  /** The classic kubeadm false alarm: the chart ships monitors for components bound to localhost, and Prometheus's own dial error is the row's words. */
  it("carries Prometheus's dial error for the control-plane monitors that cannot be reached", () => {
    for (const name of [
      "kps-kube-prometheus-stack-kube-controller-manager",
      "kps-kube-prometheus-stack-kube-etcd",
      "kps-kube-prometheus-stack-kube-scheduler",
    ]) {
      const r = row(name);
      expect(r.worst, name).toBe("err");
      expect(r.findings[0]?.kind, name).toBe("targetsDown");
      expect(
        r.findings[0]?.kind === "targetsDown" ? r.findings[0].lastError : null,
        name
      ).toMatch(/dial tcp/);
    }
  });

  it("tells a monitor whose selector matches nothing from one whose targets are down", () => {
    expect(row("selects-nothing").findings.map((f) => f.kind)).toEqual([
      "selectsNothing",
    ]);
    const demo = row("log-demo");
    expect(demo.selected).toEqual({
      kind: "services",
      names: ["k8s-gui-test/log-demo"],
    });
    expect(demo.findings.map((f) => f.kind)).toEqual(["targetsDown"]);
    expect(demo.scrape).toMatchObject({ state: "read", up: 0, down: 2 });
  });

  /** Picked up, selecting a Service, and yet no target: the operator wrote nothing for it. Not the same as down, and said apart. */
  it("marks kube-proxy and the PodMonitor as picked up with no target", () => {
    expect(
      row("kps-kube-prometheus-stack-kube-proxy").findings.map((f) => f.kind)
    ).toEqual(["noTargets"]);
    const pods = row("pods-in-shop");
    expect(pods.monitor.kind).toBe("PodMonitor");
    expect(pods.selected).toEqual({ kind: "notCounted" });
    expect(pods.findings.map((f) => f.kind)).toEqual(["noTargets"]);
  });

  it("finds nothing wrong with the monitors that are scraped", () => {
    for (const [name, up] of [
      ["kps-kube-prometheus-stack-apiserver", 1],
      ["kps-kube-prometheus-stack-coredns", 2],
      ["kps-kube-prometheus-stack-kubelet", 6],
      ["kps-kube-state-metrics", 1],
      ["kps-prometheus-node-exporter", 2],
    ] as const) {
      const r = row(name);
      expect(r.findings, name).toEqual([]);
      expect(r.scrape, name).toMatchObject({ state: "read", up, down: 0 });
    }
  });
});
