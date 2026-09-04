import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRealtimeCountdown } from "./useRealtimeAge";

/**
 * What a countdown says when there is no time left.
 *
 * It used to answer the string `"expired"`, which the CronJob page dropped
 * into `t("action", "inTime", {time})` — so a Russian reader was told the next
 * run was «через expired». The word was written in a formatter that takes a
 * number of seconds and knows nothing about a reader, which is exactly where a
 * word cannot be chosen; `isExpired` is what a caller reads to write its own
 * sentence.
 */
afterEach(() => {
  vi.useRealTimers();
});

describe("what a countdown says when the moment has passed", () => {
  it("offers no word of its own for a time already gone", () => {
    const { result } = renderHook(() =>
      useRealtimeCountdown(new Date(Date.now() - 60_000).toISOString())
    );

    expect(result.current.isExpired).toBe(true);
    // Empty, so a caller that pastes it into a sentence produces a visibly
    // broken one rather than a plausible English one nobody notices.
    expect(result.current.display).toBe("");
  });

  it("counts a future moment down in units", () => {
    const { result } = renderHook(() =>
      useRealtimeCountdown(
        new Date(Date.now() + 3 * 60_000 + 20_000).toISOString()
      )
    );

    expect(result.current.isExpired).toBe(false);
    expect(result.current.display).toMatch(/\d+m/);
  });

  /** Nothing to count down to is not the same as a countdown that ran out. */
  it("does not call a missing target expired", () => {
    const { result } = renderHook(() => useRealtimeCountdown(null));

    expect(result.current.display).toBe("");
  });
});
