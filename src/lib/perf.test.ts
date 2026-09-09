import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IPC_LIMIT_BYTES,
  IPC_TARGET_BYTES,
  NOTIFY_EVERY_MS,
  PerfRecorder,
  SAMPLE_CAP,
  measured,
  percentile,
  sizeOf,
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

describe("the IPC budget", () => {
  /** The Rust side reads the same file; a constant edited on one side only is the drift this catches. */
  it("matches shared/ipc-budget.json", () => {
    const shared = JSON.parse(
      readFileSync(resolve(process.cwd(), "shared/ipc-budget.json"), "utf8")
    ) as { targetMessageBytes: number; maxMessageBytes: number };
    expect(IPC_TARGET_BYTES).toBe(shared.targetMessageBytes);
    expect(IPC_LIMIT_BYTES).toBe(shared.maxMessageBytes);
  });
});

describe("PerfRecorder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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

  /** A run whose first, slowest call fell out of the window would report a clean run. */
  it("keeps lifetime counts and maxima past the sample cap, and says how many samples the percentiles used", () => {
    const r = new PerfRecorder();
    r.start(0);
    r.record({
      kind: "ipc",
      name: "listPods",
      ms: 900,
      at: 0,
      rows: 10000,
      bytes: 17_000_000,
    });
    for (let i = 0; i < SAMPLE_CAP; i++) {
      r.record({
        kind: "ipc",
        name: "listPods",
        ms: 5,
        at: i + 1,
        rows: 1,
        bytes: 10,
      });
    }
    const s = r.report()?.ipc.listPods;
    expect(s?.count).toBe(SAMPLE_CAP + 1);
    expect(s?.sampled).toBe(SAMPLE_CAP);
    expect(s?.max).toBe(900);
    expect(s?.maxRows).toBe(10000);
    expect(s?.maxBytes).toBe(17_000_000);
    expect(s?.p95).toBe(5);
    expect(r.report()?.sampleCap).toBe(SAMPLE_CAP);
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
  it("starts a fresh run each time and bumps its generation", () => {
    const r = new PerfRecorder();
    r.start(0);
    const first = r.generation;
    r.record({ kind: "ipc", name: "a", ms: 1, at: 1 });
    r.stop(5);
    r.start(10);
    expect(r.count("ipc")).toBe(0);
    expect(r.generation).toBe(first + 1);
  });

  /** A panel re-rendering on every one of 10 000 samples would be the stall it measures. */
  it("tells subscribers at once on start and stop, and at most every quarter second while samples stream", () => {
    const r = new PerfRecorder();
    let notified = 0;
    r.subscribe(() => notified++);
    r.start(0);
    expect(notified).toBe(1);
    for (let i = 0; i < 100; i++)
      r.record({ kind: "task", name: "longtask", ms: 60, at: i });
    expect(notified).toBe(1);
    vi.advanceTimersByTime(NOTIFY_EVERY_MS);
    expect(notified).toBe(2);
    r.stop(200);
    expect(notified).toBe(3);
  });
});

describe("measured", () => {
  /** A sample without rows and bytes cannot be checked against the IPC budget. */
  it("records duration, rows and bytes of an array answer", async () => {
    const r = new PerfRecorder();
    r.start(0);
    await measured("listPods", async () => [{ a: 1 }, { a: 2 }], r);
    const s = r.report()?.ipc.listPods;
    expect(s?.count).toBe(1);
    expect(s?.maxRows).toBe(2);
    expect(s?.maxBytes).toBe(JSON.stringify([{ a: 1 }, { a: 2 }]).length);
  });

  /** A call that started in one run and finished in the next would be counted against a run it never ran in. */
  it("drops a call that outlives its recording or lands in a later one", async () => {
    const r = new PerfRecorder();
    r.start(0);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const inFlight = measured(
      "slow",
      async () => {
        await gate;
        return [1];
      },
      r
    );
    r.stop(5);
    r.start(10);
    release();
    await inFlight;
    expect(r.count("ipc")).toBe(0);
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

  /** The wire carries UTF-8; counting UTF-16 units understates every Cyrillic namespace. */
  it("counts UTF-8 bytes, not string length", () => {
    expect(sizeOf("я")).toEqual({ bytes: 4 });
  });
});
