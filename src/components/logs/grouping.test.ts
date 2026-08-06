import { describe, it, expect } from "vitest";
import type { LogLevel } from "@/generated/types";
import { groupKeyFor } from "./normalize";
import {
  groupConsecutive,
  expandRun,
  expandRuns,
  runSpanMs,
  countCollapsed,
} from "./grouping";
import type { StreamedLogLine } from "./types";

let nextId = 0;

function line(
  message: string,
  over: {
    container?: string;
    level?: LogLevel | null;
    epoch?: number;
    fields?: Record<string, string> | null;
  } = {}
): StreamedLogLine {
  const base = {
    container: over.container ?? "app",
    level: over.level === undefined ? ("info" as LogLevel) : over.level,
    fields: over.fields ?? null,
    message,
  };
  return {
    ...base,
    id: nextId++,
    epoch: over.epoch ?? 0,
    groupKey: groupKeyFor(base),
    timestamp: null,
    format: "plain",
    raw: message,
    pod: "p",
    namespace: "n",
  };
}

describe("groupConsecutive", () => {
  it("collapses a flood into one run", () => {
    const logs = Array.from({ length: 500 }, (_, i) =>
      line(`flood line ${640000 + i} traversing the pipeline`)
    );

    const runs = groupConsecutive(logs);

    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(500);
    expect(runs[0].id).toBe(logs[0].id);
    expect(countCollapsed(runs)).toBe(499);
  });

  it("only ever collapses consecutive entries", () => {
    // The same statement either side of one different line stays two
    // runs. Gathering them would turn the count into a statistic and
    // throw away the ordering that made the log worth reading.
    const logs = [
      line("flood line 1 traversing"),
      line("flood line 2 traversing"),
      line("dropping batch: queue full"),
      line("flood line 3 traversing"),
    ];

    const runs = groupConsecutive(logs);

    expect(runs.map((r) => r.count)).toEqual([2, 1, 1]);
  });

  it("never crosses a container boundary", () => {
    const logs = [
      line("flood line 1 traversing", { container: "json-logger" }),
      line("flood line 2 traversing", { container: "web" }),
      line("flood line 3 traversing", { container: "json-logger" }),
    ];

    expect(groupConsecutive(logs).map((r) => r.count)).toEqual([1, 1, 1]);
  });

  it("never crosses a level change", () => {
    const logs = [
      line("upstream slow", { level: "info" }),
      line("upstream slow", { level: "warn" }),
      line("upstream slow", { level: "warn" }),
    ];

    const runs = groupConsecutive(logs);
    expect(runs.map((r) => r.count)).toEqual([1, 2]);
    expect(runs[1].head.level).toBe("warn");
  });

  it("gives every line its own run when collapsing is off", () => {
    const logs = [line("same 1"), line("same 2"), line("same 3")];

    const runs = groupConsecutive(logs, false);

    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.count === 1)).toBe(true);
    expect(countCollapsed(runs)).toBe(0);
  });

  it("handles an empty buffer", () => {
    expect(groupConsecutive([])).toEqual([]);
  });

  it("spans the time between the first and last line of the run", () => {
    const logs = [
      line("flood line 1 traversing", { epoch: 1000 }),
      line("flood line 2 traversing", { epoch: 4500 }),
    ];

    const runs = groupConsecutive(logs);
    expect(runSpanMs(runs[0])).toBe(3500);
    expect(runSpanMs(groupConsecutive([line("solo")])[0])).toBe(0);
  });
});

describe("expandRun", () => {
  it("hands back exactly the lines the run stands for", () => {
    const logs = [
      line("prelude"),
      line("flood line 1 traversing"),
      line("flood line 2 traversing"),
      line("flood line 3 traversing"),
      line("coda"),
    ];

    const runs = groupConsecutive(logs);
    const flood = runs.find((r) => r.count === 3)!;

    expect(expandRun(logs, flood).map((l) => l.message)).toEqual([
      "flood line 1 traversing",
      "flood line 2 traversing",
      "flood line 3 traversing",
    ]);
  });
});

describe("expandRuns", () => {
  const logs = [
    line("flood line 1 traversing"),
    line("flood line 2 traversing"),
    line("flood line 3 traversing"),
    line("dropping batch: queue full"),
  ];

  it("returns the same array when nothing is expanded", () => {
    const runs = groupConsecutive(logs);
    expect(expandRuns(logs, runs, new Set())).toBe(runs);
  });

  it("replaces an expanded run with one row per line", () => {
    const runs = groupConsecutive(logs);
    const rows = expandRuns(logs, runs, new Set([runs[0].id]));

    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.count === 1)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(logs.map((l) => l.id));
  });

  it("leaves an id that no longer names a run alone", () => {
    // The run a reader expanded can be dropped off the head of the
    // buffer while its id is still in the set.
    const runs = groupConsecutive(logs);
    expect(expandRuns(logs, runs, new Set([-1]))).toHaveLength(runs.length);
  });
});
