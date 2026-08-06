import { describe, it, expect } from "vitest";

import {
  advanceDensity,
  alignTo,
  axisLabel,
  buildDensity,
  chooseStep,
  INITIAL_CURSOR,
  stepLabel,
  type DensityCursor,
} from "./density";
import type { StreamedLogLine } from "./types";

const T0 = Date.parse("2026-08-06T12:00:00.000Z");

let nextId = 0;

function line(
  epochOffset: number,
  level: StreamedLogLine["level"] = "info"
): StreamedLogLine {
  const epoch = T0 + epochOffset;
  return {
    id: nextId++,
    epoch,
    groupKey: "k",
    timestamp: new Date(epoch).toISOString(),
    message: "m",
    level,
    format: "plain",
    fields: null,
    raw: "m",
    pod: "p",
    container: "c",
    namespace: "n",
  };
}

const cursor = (): DensityCursor => ({ ...INITIAL_CURSOR });

describe("chooseStep", () => {
  it("takes the finest rung whose slices still fit the budget", () => {
    // 8 seconds into 96 bars would be 83ms a bar; 100ms is the floor.
    expect(chooseStep(8_000, 96)).toBe(100);
    expect(chooseStep(60_000, 96)).toBe(1_000);
    expect(chooseStep(6 * 60_000, 96)).toBe(5_000);
    expect(chooseStep(4 * 3_600_000, 96)).toBe(300_000);
  });

  it("never leaves the strip a handful of fat bars", () => {
    // The rungs are at most 3x apart, so whatever the span, the slice
    // count stays above a third of the budget.
    for (let span = 1_000; span < 86_400_000; span = Math.round(span * 1.3)) {
      const step = chooseStep(span, 96);
      const slices = Math.floor(span / step) + 1;
      expect(slices).toBeLessThanOrEqual(97);
      if (step > 100) expect(slices).toBeGreaterThan(32);
    }
  });

  it("gives a narrow pane fewer, coarser slices rather than hairlines", () => {
    expect(chooseStep(6 * 60_000, 96)).toBe(5_000);
    expect(chooseStep(6 * 60_000, 40)).toBe(10_000);
  });

  it("names a slice in the unit a person would say it in", () => {
    expect(stepLabel(chooseStep(8_000, 96))).toBe("100 ms");
    expect(stepLabel(chooseStep(6 * 60_000, 96))).toBe("5 s");
    expect(stepLabel(chooseStep(4 * 3_600_000, 96))).toBe("5 min");
    expect(stepLabel(chooseStep(40 * 3_600_000, 96))).toBe("30 min");
  });
});

describe("alignTo", () => {
  it("puts slice boundaries on the clock, not on the first line", () => {
    const offset = new Date(T0).getTimezoneOffset() * 60_000;
    const start = alignTo(T0 + 12_345, 5_000, offset);
    expect((start - offset) % 5_000).toBe(0);
    expect(start).toBeLessThanOrEqual(T0 + 12_345);
  });
});

describe("buildDensity", () => {
  it("leaves silence as empty slices instead of packing the bars", () => {
    const density = buildDensity([line(0), line(60_000)], 1_000);
    expect(density.buckets.length).toBe(61);
    expect(density.buckets.filter((b) => b.total > 0).length).toBe(2);
  });

  it("counts fatal as an error and keeps warnings apart", () => {
    const density = buildDensity(
      [
        line(0, "fatal"),
        line(10, "error"),
        line(20, "warn"),
        line(30, "debug"),
      ],
      1_000
    );
    expect(density.buckets[0]).toMatchObject({ total: 4, err: 2, warn: 1 });
    expect(density.errorSlices).toBe(1);
  });

  it("is empty for an empty buffer rather than a slice of nothing", () => {
    expect(buildDensity([], 1_000).buckets).toEqual([]);
  });
});

describe("advanceDensity", () => {
  it("extending batch by batch agrees with a rebuild", () => {
    nextId = 0;
    const all = Array.from({ length: 600 }, (_, i) =>
      line(i * 40, i % 97 === 0 ? "error" : i % 13 === 0 ? "warn" : "info")
    );
    const state = cursor();
    let density = advanceDensity(state, [], 96, "s");
    for (let end = 50; end <= all.length; end += 50) {
      density = advanceDensity(state, all.slice(0, end), 96, "s");
    }
    const fresh = buildDensity(all, density.step);
    expect(density.buckets).toEqual(fresh.buckets);
    expect(density.lines).toBe(fresh.lines);
    expect(density.errors).toBe(fresh.errors);
    expect(density.peak).toBe(fresh.peak);
  });

  it("agrees with a rebuild while the cap is evicting the head", () => {
    nextId = 0;
    const all = Array.from({ length: 900 }, (_, i) =>
      line(i * 25, i % 51 === 0 ? "error" : "info")
    );
    const state = cursor();
    const limit = 300;
    let window: StreamedLogLine[] = [];
    for (let end = 60; end <= all.length; end += 60) {
      window = all.slice(Math.max(0, end - limit), end);
      advanceDensity(state, window, 96, "s");
    }
    const density = advanceDensity(state, window, 96, "s");
    const fresh = buildDensity(window, density.step);
    expect(density.buckets).toEqual(fresh.buckets);
    expect(density.lines).toBe(window.length);
  });

  it("rebuilds when the query changes rather than adding to the old shape", () => {
    nextId = 0;
    const all = Array.from({ length: 200 }, (_, i) => line(i * 100));
    const state = cursor();
    advanceDensity(state, all, 96, "all");
    const half = all.filter((_, i) => i % 2 === 0);
    const density = advanceDensity(state, half, 96, "half");
    expect(density.lines).toBe(half.length);
    expect(density.buckets).toEqual(buildDensity(half, density.step).buckets);
  });

  it("is idempotent, so a double render cannot double-count", () => {
    nextId = 0;
    const all = Array.from({ length: 120 }, (_, i) => line(i * 100));
    const state = cursor();
    const first = advanceDensity(state, all, 96, "s");
    const second = advanceDensity(state, all, 96, "s");
    expect(second.buckets).toEqual(first.buckets);
    expect(second.lines).toBe(first.lines);
  });

  it("hands back a fresh snapshot, never the slices it keeps mutating", () => {
    nextId = 0;
    const all = Array.from({ length: 40 }, (_, i) => line(i * 100));
    const state = cursor();
    const first = advanceDensity(state, all, 96, "s");
    const before = first.buckets[0].total;
    advanceDensity(state, [...all, line(4_000)], 96, "s");
    expect(first.buckets[0].total).toBe(before);
  });

  it("takes a line that arrived a window late without losing it", () => {
    nextId = 0;
    const state = cursor();
    const base = [line(5_000), line(5_100), line(5_200)];
    advanceDensity(state, base, 96, "s");
    // A container running a reorder window behind lands before the head.
    const late = line(4_700);
    const density = advanceDensity(state, [...base, late], 96, "s");
    expect(density.lines).toBe(4);
    expect(density.buckets[0].start).toBeLessThanOrEqual(late.epoch);
  });

  it("empties when the buffer is cleared", () => {
    nextId = 0;
    const state = cursor();
    advanceDensity(state, [line(0), line(1_000)], 96, "s");
    expect(advanceDensity(state, [], 96, "s").buckets).toEqual([]);
  });
});

describe("axisLabel", () => {
  it("drops the seconds once a slice is a minute wide", () => {
    expect(axisLabel(T0, 1_000, 60_000)).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(axisLabel(T0, 60_000, 3_600_000)).toMatch(/^\d\d:\d\d$/);
  });

  it("spells the day out once the clock could wrap", () => {
    expect(axisLabel(T0, 3_600_000, 3 * 86_400_000)).toMatch(
      /^\d+ [A-Z][a-z]{2} \d\d:\d\d$/
    );
  });
});
