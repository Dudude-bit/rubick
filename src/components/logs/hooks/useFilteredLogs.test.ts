import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { SLICE_LINES, useFilteredLogs } from "./useFilteredLogs";
import type { QueryTerm, StreamedLogLine } from "../types";

let reads = 0;

/** A line that counts how often the filter looks at its text. */
const line = (id: number, message = `m${id}`) => {
  const built = {
    id,
    epoch: id,
    container: "app",
    level: "info",
    raw: message,
  } as StreamedLogLine;
  Object.defineProperty(built, "message", {
    get() {
      reads++;
      return message;
    },
    enumerable: true,
  });
  return built;
};
const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) =>
    line(from + i, i % 10 === 0 ? `hit ${from + i}` : `m${from + i}`)
  );

const HIT: QueryTerm[] = [{ kind: "text", value: "hit" }];
const NONE: ReadonlySet<string> = new Set();

beforeEach(() => {
  vi.useFakeTimers();
  reads = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useFilteredLogs", () => {
  /** A small buffer answers in the render, as it always did: nothing to settle. */
  it("filters a buffer under one slice in the same render", () => {
    const logs = lines(0, 100);
    const { result } = renderHook(() => useFilteredLogs(logs, NONE, HIT));
    expect(result.current.settling).toBe(false);
    expect(result.current.scoped.map((l) => l.id)).toEqual(
      logs.filter((l) => l.raw.startsWith("hit")).map((l) => l.id)
    );
  });

  /** The cost of a batch is the batch: forty thousand lines are not looked at again for four hundred new ones. */
  it("looks only at the appended lines when a batch lands", () => {
    let logs = lines(0, SLICE_LINES);
    const { result, rerender } = renderHook(
      ({ logs }) => useFilteredLogs(logs, NONE, HIT),
      { initialProps: { logs } }
    );
    expect(result.current.settling).toBe(false);
    const before = result.current.scoped;
    reads = 0;
    logs = [...logs.slice(400), ...lines(SLICE_LINES, 400)];
    rerender({ logs });
    expect(reads).toBe(400);
    expect(result.current.settling).toBe(false);
    expect(result.current.scoped.length).toBe(before.length);
    expect(result.current.scoped[0].id).toBe(400);
    expect(result.current.scoped.at(-1)?.id).toBe(SLICE_LINES + 390);
  });

  /** A big buffer is walked in slices with the event loop between them, so the input keeps answering; the caller is told the walk is on. */
  it("walks a new query over a big buffer in slices and says so", () => {
    const logs = lines(0, SLICE_LINES * 3);
    const { result } = renderHook(() => useFilteredLogs(logs, NONE, HIT));
    expect(result.current.settling).toBe(true);
    expect(reads).toBe(SLICE_LINES);
    expect(result.current.scoped.length).toBe(SLICE_LINES / 10);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.settling).toBe(true);
    expect(reads).toBe(SLICE_LINES * 2);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.settling).toBe(false);
    expect(reads).toBe(SLICE_LINES * 3);
    expect(result.current.scoped.length).toBe((SLICE_LINES * 3) / 10);
  });

  /** A batch arriving mid-walk is neither lost nor a reason to start over. */
  it("keeps walking after a batch lands mid-pass and reaches the tail", () => {
    let logs = lines(0, SLICE_LINES * 2);
    const { result, rerender } = renderHook(
      ({ logs }) => useFilteredLogs(logs, NONE, HIT),
      { initialProps: { logs } }
    );
    expect(result.current.settling).toBe(true);
    logs = [...logs.slice(100), ...lines(SLICE_LINES * 2, 100)];
    rerender({ logs });
    act(() => vi.runAllTimers());
    expect(result.current.settling).toBe(false);
    expect(reads).toBe(SLICE_LINES * 2 + 100);
    expect(result.current.scoped.map((l) => l.id)).toEqual(
      logs.filter((l) => l.raw.startsWith("hit")).map((l) => l.id)
    );
  });

  /** Changing the query mid-walk abandons the old walk; the new one is what the reader asked for. */
  it("starts over on the new query when the query changes mid-pass", () => {
    const logs = lines(0, SLICE_LINES * 2);
    const { result, rerender } = renderHook(
      ({ terms }) => useFilteredLogs(logs, NONE, terms),
      { initialProps: { terms: HIT } }
    );
    const other: QueryTerm[] = [{ kind: "text", value: "m1" }];
    rerender({ terms: other });
    act(() => vi.runAllTimers());
    expect(result.current.settling).toBe(false);
    expect(result.current.scoped.map((l) => l.id)).toEqual(
      logs.filter((l) => l.raw.includes("m1")).map((l) => l.id)
    );
  });

  /** A buffer that is not the old one extended (cleared, or a different pod) is walked from the start, not patched. */
  it("walks a replaced buffer from the start", () => {
    let logs = lines(0, 50);
    const { result, rerender } = renderHook(
      ({ logs }) => useFilteredLogs(logs, NONE, HIT),
      { initialProps: { logs } }
    );
    logs = lines(1000, 50);
    rerender({ logs });
    expect(result.current.scoped.map((l) => l.id)).toEqual([
      1000, 1010, 1020, 1030, 1040,
    ]);
    logs = [];
    rerender({ logs });
    expect(result.current.scoped).toEqual([]);
  });

  /** The view keeps its identity when nothing it holds changed, so the memos downstream stay quiet. */
  it("keeps the same array when a batch adds nothing that matches", () => {
    let logs = lines(0, 10);
    const { result, rerender } = renderHook(
      ({ logs }) => useFilteredLogs(logs, NONE, HIT),
      { initialProps: { logs } }
    );
    const before = result.current.scoped;
    logs = [...logs, line(11, "quiet"), line(12, "quiet")];
    rerender({ logs });
    expect(result.current.scoped).toBe(before);
  });
});
