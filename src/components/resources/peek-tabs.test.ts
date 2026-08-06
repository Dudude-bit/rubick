import { describe, expect, it } from "vitest";

import { peekTabsFor, resolvePeekTab } from "./peek-tabs";

const labels = (kind: string) => peekTabsFor(kind).map((tab) => tab.label);
const ids = (kind: string) => peekTabsFor(kind).map((tab) => tab.id);

describe("peekTabsFor", () => {
  it("gives every kind an overview and a manifest", () => {
    for (const kind of ["Service", "Node", "Namespace", "StorageClass"]) {
      expect(labels(kind)).toEqual(["Overview", "YAML"]);
    }
  });

  it("gives a pod its logs and its containers", () => {
    expect(labels("Pod")).toEqual(["Overview", "Logs", "Containers", "YAML"]);
  });

  it("gives the two key/value kinds a data tab", () => {
    expect(labels("ConfigMap")).toEqual(["Overview", "Data", "YAML"]);
    expect(labels("Secret")).toEqual(["Overview", "Data", "YAML"]);
  });

  it("gives a controller the objects it owns", () => {
    for (const kind of ["Deployment", "StatefulSet", "DaemonSet", "Job"]) {
      expect(labels(kind)).toEqual(["Overview", "Pods", "YAML"]);
    }
    // A CronJob's pods belong to its runs, not to it.
    expect(labels("CronJob")).toEqual(["Overview", "Jobs", "YAML"]);
  });

  it("reads the plural form a peek URL carries", () => {
    expect(labels("pods")).toEqual(["Overview", "Logs", "Containers", "YAML"]);
    expect(labels("configmaps")).toEqual(["Overview", "Data", "YAML"]);
  });

  it("keeps one id for both child lists, so the tab survives the switch", () => {
    expect(ids("Deployment")).toContain("children");
    expect(ids("CronJob")).toContain("children");
  });

  it("never offers a tab to a kind that cannot answer it", () => {
    expect(ids("ConfigMap")).not.toContain("logs");
    expect(ids("Service")).not.toContain("containers");
    expect(ids("Pod")).not.toContain("data");
  });
});

describe("resolvePeekTab", () => {
  it("keeps the reader's tab when the new target has it", () => {
    expect(resolvePeekTab("logs", peekTabsFor("Pod"))).toBe("logs");
  });

  it("falls back to overview when the new target has no such tab", () => {
    expect(resolvePeekTab("logs", peekTabsFor("ConfigMap"))).toBe("overview");
    expect(resolvePeekTab("data", peekTabsFor("Pod"))).toBe("overview");
  });

  // The request is remembered even while it cannot be honoured, so walking
  // Pod → ConfigMap → Pod lands back on Logs.
  it("does not consume the request it fell back from", () => {
    const requested = "logs";
    expect(resolvePeekTab(requested, peekTabsFor("ConfigMap"))).toBe(
      "overview"
    );
    expect(resolvePeekTab(requested, peekTabsFor("Pod"))).toBe("logs");
  });
});
