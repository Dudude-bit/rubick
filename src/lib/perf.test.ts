import { describe, expect, it } from "vitest";

import {
  PerfRecorder,
  SAMPLE_CAP,
  measured,
  percentile,
  sizeOf,
  summarise,
} from "./perf";

describe("percentile", () => {
  /** A p95 that reads past the end would crash the report on tiny samples. */
  it("reads the nearest rank and never past either end", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 99)).toBe(4);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
  });
});

describe("summarise", () => {
  /** A stat without the largest answer cannot say whether the IPC budget held. */
  it("carries the largest rows and bytes seen, and omits them when no sample had any", () => {
    const stats = summarise([
      { kind: "ipc", name: "a", ms: 10, at: 0, rows: 5, bytes: 100 },
      { kind: "ipc", name: "a", ms: 30, at: 0, rows: 50, bytes: 20 },
    ]);
    expect(stats).toMatchObject({
      count: 2,
      p50: 10,
      max: 30,
      totalMs: 40,
      maxRows: 50,
      maxBytes: 100,
    });
    const bare = summarise([{ kind: "task", name: "t", ms: 60, at: 0 }]);
    expect("maxRows" in bare).toBe(false);
    expect("maxBytes" in bare).toBe(false);
  });
});

describe("PerfRecorder", () => {
  /** Recording while off would make every command pay for serialising its answer. */
  it("keeps nothing until started and nothing after stopped", () => {
    const r = new PerfRecorder();
    r.record({ kind: "ipc", name: "x", ms: 1, at: 0 });
    expect(r.report()).toBeNull();
    r.start(0);
    r.record({ kind: "ipc", name: "x", ms: 1, at: 1 });
    r.stop(10);
    r.record({ kind: "ipc", name: "x", ms: 1, at: 2 });
    expect(r.count("ipc")).toBe(1);
    expect(r.report()?.durationMs).toBe(10);
  });

  /** An unbounded buffer would turn a long recording into the leak it measures. */
  it("drops the oldest samples past the cap", () => {
    const r = new PerfRecorder();
    r.start(0);
    for (let i = 0; i < SAMPLE_CAP + 10; i++) {
      r.record({ kind: "task", name: "longtask", ms: i, at: i });
    }
    expect(r.count("task")).toBe(SAMPLE_CAP);
    expect(r.report()?.tasks?.max).toBe(SAMPLE_CAP + 9);
  });

  /** Two commands folded into one row would hide which one is slow. */
  it("groups ipc and render samples by name and leaves tasks null when there were none", () => {
    const r = new PerfRecorder();
    r.start(0);
    r.record({
      kind: "ipc",
      name: "listPods",
      ms: 120,
      at: 1,
      rows: 10000,
      bytes: 1,
    });
    r.record({
      kind: "ipc",
      name: "listPods",
      ms: 80,
      at: 2,
      rows: 10000,
      bytes: 1,
    });
    r.record({ kind: "ipc", name: "getNode", ms: 5, at: 3 });
    r.record({ kind: "render", name: "data-table", ms: 9, at: 4 });
    const report = r.report(100);
    expect(Object.keys(report?.ipc ?? {}).sort()).toEqual([
      "getNode",
      "listPods",
    ]);
    expect(report?.ipc.listPods.count).toBe(2);
    expect(report?.renders["data-table"].max).toBe(9);
    expect(report?.tasks).toBeNull();
  });

  /** A start that kept the previous run's samples would report two runs as one. */
  it("starts a fresh run each time and tells subscribers about every change", () => {
    const r = new PerfRecorder();
    let notified = 0;
    r.subscribe(() => notified++);
    r.start(0);
    r.record({ kind: "ipc", name: "a", ms: 1, at: 1 });
    r.stop(5);
    r.start(10);
    expect(r.count("ipc")).toBe(0);
    expect(notified).toBe(4);
  });
});

describe("measured", () => {
  /** The wrapper is on every command; a cost while idle is a cost everywhere. */
  it("runs the call untouched while nothing records", async () => {
    const r = new PerfRecorder();
    const value = await measured("listPods", async () => [1, 2, 3], r);
    expect(value).toEqual([1, 2, 3]);
    expect(r.report()).toBeNull();
  });

  /** A sample without rows and bytes cannot be checked against the IPC budget. */
  it("records duration, rows and bytes of an array answer while recording", async () => {
    const r = new PerfRecorder();
    r.start(0);
    await measured("listPods", async () => [{ a: 1 }, { a: 2 }], r);
    const stats = r.report()?.ipc.listPods;
    expect(stats?.count).toBe(1);
    expect(stats?.maxRows).toBe(2);
    expect(stats?.maxBytes).toBe(JSON.stringify([{ a: 1 }, { a: 2 }]).length);
  });

  /** A thrown command must still throw; swallowing it would hide the failure it timed. */
  it("lets a failing call fail and records nothing for it", async () => {
    const r = new PerfRecorder();
    r.start(0);
    await expect(
      measured(
        "boom",
        async () => {
          throw new Error("no");
        },
        r
      )
    ).rejects.toThrow("no");
    expect(r.count("ipc")).toBe(0);
  });
});

describe("sizeOf", () => {
  /** A cyclic answer would make the recorder itself the thing that crashes. */
  it("has no byte count for a value that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(sizeOf(cyclic)).toEqual({});
    expect(sizeOf([1])).toEqual({ rows: 1, bytes: 3 });
    expect(sizeOf(undefined)).toEqual({ bytes: 0 });
  });
});
