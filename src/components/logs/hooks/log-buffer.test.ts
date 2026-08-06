import { describe, it, expect } from "vitest";
import {
  appendCapped,
  backfillPerContainer,
  emptyBuffer,
  fieldSuggestions,
  MAX_TRACKED_VALUES,
  orderByTimestamp,
  type LogBuffer,
} from "./log-buffer";
import type { StreamedLogLine } from "../types";

const line = (id: number, epoch = id) =>
  ({
    id,
    epoch,
    message: `m${id}`,
    container: "app",
    level: "info",
  }) as StreamedLogLine;
const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => line(from + i));

const buffered = (lines: StreamedLogLine[], dropped = 0): LogBuffer =>
  appendCapped({ ...emptyBuffer(), dropped }, lines, lines.length);

describe("orderByTimestamp", () => {
  it("returns the input untouched when it is already ordered", () => {
    // The single-container case, which is still the common one: every
    // window arrives ordered and the sort would be pure waste.
    const pending = lines(0, 5);
    expect(orderByTimestamp(pending)).toBe(pending);
  });

  it("puts two containers' lines into timestamp order", () => {
    const a = { ...line(1), epoch: 300 } as StreamedLogLine;
    const b = { ...line(2), epoch: 100 } as StreamedLogLine;
    const c = { ...line(3), epoch: 200 } as StreamedLogLine;

    expect(orderByTimestamp([a, b, c]).map((l) => l.epoch)).toEqual([
      100, 200, 300,
    ]);
  });

  it("breaks a tie by arrival order and never reorders equal stamps", () => {
    // Two containers reporting the same millisecond is normal, and the
    // id is a total order, so the result does not depend on the sort
    // implementation being stable.
    const first = { ...line(7), epoch: 500 } as StreamedLogLine;
    const second = { ...line(8), epoch: 500 } as StreamedLogLine;
    const early = { ...line(9), epoch: 100 } as StreamedLogLine;

    expect(orderByTimestamp([second, first, early]).map((l) => l.id)).toEqual([
      9, 7, 8,
    ]);
  });

  it("does not mutate the window it was given", () => {
    const pending = [line(2, 200), line(1, 100)];
    orderByTimestamp(pending);
    expect(pending.map((l) => l.id)).toEqual([2, 1]);
  });
});

describe("appendCapped", () => {
  it("returns a new array so React sees the change", () => {
    const prev = buffered(lines(0, 3));
    const next = appendCapped(prev, lines(3, 2), 100);

    expect(next.lines).not.toBe(prev.lines);
    expect(prev.lines).toHaveLength(3);
    expect(next.lines.map((l) => l.id)).toEqual([0, 1, 2, 3, 4]);
    expect(next.dropped).toBe(0);
  });

  it("drops from the head once the cap is reached, keeping the newest", () => {
    const next = appendCapped(buffered(lines(0, 100)), lines(100, 10), 100);

    expect(next.lines).toHaveLength(100);
    expect(next.lines[0].id).toBe(10);
    expect(next.lines[99].id).toBe(109);
  });

  it("counts what it dropped, so the viewer can stop being silently lossy", () => {
    let buffer = appendCapped(emptyBuffer(), lines(0, 100), 100);
    expect(buffer.dropped).toBe(0);

    buffer = appendCapped(buffer, lines(100, 10), 100);
    expect(buffer.dropped).toBe(10);

    buffer = appendCapped(buffer, lines(110, 25), 100);
    expect(buffer.dropped).toBe(35);
  });

  it("keeps only the tail of a window that is itself over the cap", () => {
    const next = appendCapped(buffered(lines(0, 5)), lines(100, 120), 100);

    expect(next.lines).toHaveLength(100);
    expect(next.lines[0].id).toBe(120);
    expect(next.dropped).toBe(25);
  });

  it("is a no-op on an empty window", () => {
    const prev = buffered(lines(0, 3), 4);
    expect(appendCapped(prev, [], 100)).toBe(prev);
  });
});

const fielded = (
  id: number,
  container: string,
  fields: Record<string, string>
) => ({ ...line(id), container, fields }) as StreamedLogLine;

describe("the field index", () => {
  it("offers level and container first, then the loudest parsed keys", () => {
    const buffer = appendCapped(
      emptyBuffer(),
      [
        fielded(1, "app", { component: "ingest", upstream: "db" }),
        fielded(2, "app", { component: "ingest" }),
        fielded(3, "sidecar", { component: "api" }),
      ],
      100
    );

    expect(fieldSuggestions(buffer.fields).map((f) => f.key)).toEqual([
      "level",
      "container",
      "component",
      "upstream",
    ]);
  });

  it("counts values so the popover can rank them", () => {
    const buffer = appendCapped(
      emptyBuffer(),
      [
        fielded(1, "app", { component: "ingest" }),
        fielded(2, "app", { component: "ingest" }),
        fielded(3, "sidecar", { component: "api" }),
      ],
      100
    );

    const component = fieldSuggestions(buffer.fields).find(
      (f) => f.key === "component"
    )!;
    expect(component.lines).toBe(3);
    expect(component.values).toEqual([
      { value: "ingest", lines: 2 },
      { value: "api", lines: 1 },
    ]);

    const container = fieldSuggestions(buffer.fields).find(
      (f) => f.key === "container"
    )!;
    expect(container.values).toEqual([
      { value: "app", lines: 2 },
      { value: "sidecar", lines: 1 },
    ]);
  });

  it("uncounts what eviction dropped, so the index describes what is left", () => {
    // The whole reason it is accumulated rather than recounted: nothing
    // walks the buffer, so the head leaving has to say so on its way out.
    let buffer = appendCapped(
      emptyBuffer(),
      [
        fielded(1, "app", { component: "ingest" }),
        fielded(2, "sidecar", { component: "api" }),
      ],
      2
    );
    buffer = appendCapped(
      buffer,
      [fielded(3, "sidecar", { component: "api" })],
      2
    );

    expect(buffer.fields.keys.get("component")).toBe(2);
    expect(buffer.fields.values.get("component")).toEqual(
      new Map([["api", 2]])
    );
    expect(buffer.fields.values.get("container")).toEqual(
      new Map([["sidecar", 2]])
    );
  });

  it("stops listing a key with one value per line, and says how many lines", () => {
    // `request_id`: listing its values is ten thousand buttons nobody
    // reads, so past the cap only the line count survives.
    const buffer = appendCapped(
      emptyBuffer(),
      Array.from({ length: MAX_TRACKED_VALUES + 10 }, (_, i) =>
        fielded(i, "app", { request_id: `r${i}` })
      ),
      1000
    );

    const wide = fieldSuggestions(buffer.fields).find(
      (f) => f.key === "request_id"
    )!;
    expect(wide.wide).toBe(true);
    expect(wide.values).toEqual([]);
    expect(wide.lines).toBe(MAX_TRACKED_VALUES + 10);
  });

  it("never offers the key the message itself was parsed out of", () => {
    const buffer = appendCapped(
      emptyBuffer(),
      [fielded(1, "app", { msg: "hello", severity: "high", trace: "abc" })],
      100
    );

    expect(fieldSuggestions(buffer.fields).map((f) => f.key)).toEqual([
      "level",
      "container",
      "trace",
    ]);
  });

  it("hands back a fresh index object so a memo on it re-runs", () => {
    const first = appendCapped(emptyBuffer(), lines(0, 2), 100);
    const second = appendCapped(first, lines(2, 2), 100);
    expect(second.fields).not.toBe(first.fields);
  });
});

describe("backfillPerContainer", () => {
  it("splits the cap across the containers being streamed", () => {
    // Asking five containers for 5 000 each would fetch 25 000 lines to
    // keep 5 000, and report a dropped head on a pane just opened.
    expect(backfillPerContainer(5000, 5)).toBe(1000);
    expect(backfillPerContainer(5000, 1)).toBe(5000);
    expect(backfillPerContainer(1000, 3)).toBe(334);
  });

  it("always asks for at least one line", () => {
    expect(backfillPerContainer(1, 40)).toBe(1);
    expect(backfillPerContainer(0, 0)).toBe(1);
  });
});
