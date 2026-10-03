import { describe, expect, it } from "vitest";

import { ResourceType } from "@/lib/resource-registry";
import { peekTabsFor, resolvePeekTab, type PeekTabId } from "./peek-tabs";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

const labels = (kind: string) => peekTabsFor(kind, t).map((tab) => tab.label);
const ids = (kind: string) => peekTabsFor(kind, t).map((tab) => tab.id);
const tab = (kind: string, id: PeekTabId, detail?: unknown) =>
  peekTabsFor(kind, t, detail).find((entry) => entry.id === id)!;

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

describe("the glyph a peek tab carries", () => {
  it("gives one to every tab of every kind, so the strip is not half marked", () => {
    for (const kind of ["Pod", "ConfigMap", "Deployment", "CronJob", "Node"]) {
      for (const entry of peekTabsFor(kind, t)) {
        expect(entry.glyph).toBeDefined();
      }
    }
  });

  it("takes the kind's own glyph where the tab opens onto objects of a kind", () => {
    expect(tab("Deployment", "children").glyph).toEqual({
      names: "kind",
      kind: ResourceType.Pod,
    });
    // A CronJob's tab lists runs, so it is a Job that is named there.
    expect(tab("CronJob", "children").glyph).toEqual({
      names: "kind",
      kind: ResourceType.Job,
    });
    // A container has no kind of its own; it is what a Pod is made of.
    expect(tab("Pod", "containers").glyph).toEqual({
      names: "kind",
      kind: ResourceType.Pod,
    });
  });

  it("takes a functional glyph and no hue for a way of looking at this object", () => {
    for (const id of ["overview", "logs", "yaml"] as PeekTabId[]) {
      expect(tab("Pod", id).glyph.names).toBe("view");
    }
    expect(tab("ConfigMap", "data").glyph.names).toBe("view");
  });
});

describe("the marks a peek can afford", () => {
  const pod = {
    containers: [{ phase: "app" }, { phase: "sidecar" }],
    initContainers: [{ phase: "init" }],
  };

  it("counts what the overview fetch already handed it", () => {
    expect(tab("Pod", "containers", pod).mark).toEqual({
      shows: "count",
      of: 3,
    });
    expect(tab("ConfigMap", "data", { dataKeys: ["a", "b"] }).mark).toEqual({
      shows: "count",
      of: 2,
    });
  });

  it("marks nothing before that fetch lands", () => {
    expect(tab("Pod", "containers").mark).toBeUndefined();
    expect(tab("ConfigMap", "data").mark).toBeUndefined();
  });

  it("buys no badge with a fetch — a child list is not counted here", () => {
    expect(tab("Deployment", "children", { name: "web" }).mark).toBeUndefined();
    expect(tab("CronJob", "children", { name: "cron" }).mark).toBeUndefined();
  });
});

describe("resolvePeekTab", () => {
  it("keeps the reader's tab when the new target has it", () => {
    expect(resolvePeekTab("logs", peekTabsFor("Pod", t))).toBe("logs");
  });

  it("falls back to overview when the new target has no such tab", () => {
    expect(resolvePeekTab("logs", peekTabsFor("ConfigMap", t))).toBe(
      "overview"
    );
    expect(resolvePeekTab("data", peekTabsFor("Pod", t))).toBe("overview");
  });

  // The request is remembered even while it cannot be honoured, so walking
  // Pod → ConfigMap → Pod lands back on Logs.
  it("does not consume the request it fell back from", () => {
    const requested = "logs";
    expect(resolvePeekTab(requested, peekTabsFor("ConfigMap", t))).toBe(
      "overview"
    );
    expect(resolvePeekTab(requested, peekTabsFor("Pod", t))).toBe("logs");
  });
});
