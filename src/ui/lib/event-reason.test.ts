import { describe, it, expect } from "vite-plus/test";

import { eventReasonMark, reasonWords, type EventFamily } from "./event-reason";
import { RESOURCE_REGISTRY } from "./resource-registry";

/** One reason per family, and the family it has to land in. */
const SAMPLES: Record<EventFamily, string> = {
  image: "Pulled",
  lifecycle: "Started",
  scheduling: "FailedScheduling",
  controller: "SuccessfulCreate",
  health: "Unhealthy",
  storage: "FailedMount",
  node: "NodeNotReady",
};

const FAMILIES = Object.keys(SAMPLES) as EventFamily[];

describe("eventReasonMark", () => {
  it("groups the reasons this cluster emits", () => {
    for (const [family, reason] of Object.entries(SAMPLES)) {
      expect(eventReasonMark(reason).family).toBe(family);
    }
  });

  it("matches regardless of case", () => {
    expect(eventReasonMark("successfulcreate").family).toBe("controller");
    expect(eventReasonMark("SUCCESSFULCREATE").family).toBe("controller");
  });

  it("leaves an unknown reason unclaimed rather than guessing", () => {
    for (const reason of ["FluxReconcileFailed", "", null]) {
      const mark = eventReasonMark(reason);
      expect(mark.family).toBeNull();
    }
  });

  it("gives every family its own shape", () => {
    const icons = new Set(
      FAMILIES.map((f) => eventReasonMark(SAMPLES[f]).Icon)
    );
    expect(icons.size).toBe(FAMILIES.length);
    // The unknown mark has to differ from all of them too, or "we don't know"
    // is indistinguishable from a family the event has nothing to do with.
    expect(icons.has(eventReasonMark("NoSuchReason").Icon)).toBe(false);
  });

  it("never reuses a kind's glyph", () => {
    // The family glyph and the involved object's kind glyph sit eight pixels
    // apart in the same row; sharing one collapses two channels into one.
    const kinds = new Set(RESOURCE_REGISTRY.map((entry) => entry.icon));
    for (const family of FAMILIES) {
      expect(kinds.has(eventReasonMark(SAMPLES[family]).Icon)).toBe(false);
    }
  });

  /**
   * Pulled pink, Started teal and SuccessfulDelete green made the Normal
   * reasons the loudest thing in the feed. Fails if a mark carries a colour again.
   */
  it("carries no colour: only a Warning's own tone paints a reason", () => {
    for (const reason of Object.values(SAMPLES)) {
      expect(eventReasonMark(reason)).not.toHaveProperty("color");
    }
  });
});

describe("reasonWords", () => {
  /** Dana read "Succ…" for both SuccessfulCreate and SuccessfulDelete; fails if a reason stops breaking between its own words. */
  it("breaks a reason between the words of its CamelCase", () => {
    expect(reasonWords("SuccessfulCreate")).toEqual(["Successful", "Create"]);
    expect(reasonWords("FailedGetResourceMetric")).toEqual([
      "Failed",
      "Get",
      "Resource",
      "Metric",
    ]);
    expect(reasonWords("OOMKilling")).toEqual(["OOM", "Killing"]);
    expect(reasonWords("NodeHasSufficientPID")).toEqual([
      "Node",
      "Has",
      "Sufficient",
      "PID",
    ]);
  });

  /** Fails if a break point ever drops or adds a character of the cluster's word. */
  it("joins back to the reason exactly", () => {
    for (const reason of [
      "Init:CreateContainerConfigError",
      "BackOff",
      "app-started_v2",
      "CIDRNotAvailable",
      "Pulled",
    ])
      expect(reasonWords(reason).join("")).toBe(reason);
  });
});
