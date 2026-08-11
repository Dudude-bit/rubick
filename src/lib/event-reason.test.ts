import { describe, it, expect } from "vitest";

import { eventReasonMark, type EventFamily } from "./event-reason";
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

function hueOf(reason: string): number {
  const colour = eventReasonMark(reason).color;
  const match = colour && /^hsl\((\d+) /.exec(colour);
  if (!match) throw new Error(`no hue for ${reason}`);
  return Number(match[1]);
}

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
      expect(mark.color).toBeNull();
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

  it("keeps every hue clear of the severity bands", () => {
    for (const family of FAMILIES) {
      const hue = hueOf(SAMPLES[family]);
      // 0-60 is --err through --warn; 140-160 is --ok. A family in either
      // asserts a severity the event type never said.
      expect(hue).toBeGreaterThan(60);
      expect(hue < 140 || hue > 160).toBe(true);
    }
  });

  it("keeps the families apart on the ring", () => {
    const hues = FAMILIES.map((f) => hueOf(SAMPLES[f])).sort((a, b) => a - b);
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i] - hues[i - 1]).toBeGreaterThanOrEqual(25);
    }
  });

  it("saturation and lightness stay in CSS so both themes track", () => {
    expect(eventReasonMark("Pulled").color).toContain("var(--evt-s)");
    expect(eventReasonMark("Pulled").color).toContain("var(--evt-l)");
  });
});
