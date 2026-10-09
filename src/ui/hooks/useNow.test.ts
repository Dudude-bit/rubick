// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useLastPassed } from "./useNow";

afterEach(() => {
  vi.useRealTimers();
});

describe("a clock that moves at deadlines", () => {
  /**
   * Sam's unplaced pod turned amber on its page at about t+61 s and on the
   * Overview at t+67 s, each on its own tick. Fails if a deadline is read
   * before it passes, or later than the moment it does.
   */
  it("moves the moment each deadline passes, and not before", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const deadlines = [start + 60_000, start + 90_000];
    const { result } = renderHook(() => useLastPassed(deadlines));
    expect(result.current).toBe(Number.NEGATIVE_INFINITY);

    act(() => vi.advanceTimersByTime(59_999));
    expect(result.current).toBe(Number.NEGATIVE_INFINITY);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(start + 60_000);

    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current).toBe(start + 90_000);
  });
});
