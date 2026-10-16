// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useRealtimeAge, useRealtimeCountdown } from "./useRealtimeAge";

/**
 * What a countdown says when there is no time left.
 *
 * The formatter takes a number of seconds and knows nothing about a reader,
 * so it offers no word of its own: `"expired"` reached the CronJob page's
 * `t("action", "inTime", {time})` and told a Russian reader the next run was
 * «через expired». `isExpired` is what a caller reads to write its own
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

  /**
   * Nothing to count down to is not the same as a countdown that ran out.
   *
   * A `null` target measures as zero seconds, so both can answer
   * `isExpired: true` and `warningLevel: "critical"` — a deadline nobody set,
   * painted in the colour of one that has passed. The empty `display` cannot
   * tell them apart, so asserting on it alone notices nothing.
   */
  it("does not call a missing target expired", () => {
    const missing = renderHook(() => useRealtimeCountdown(null));
    expect(missing.result.current.display).toBe("");
    expect(missing.result.current.isExpired).toBe(false);
    expect(missing.result.current.warningLevel).toBe("none");

    const gone = renderHook(() =>
      useRealtimeCountdown(new Date(Date.now() - 60_000).toISOString())
    );
    expect(gone.result.current.display).toBe("");
    expect(gone.result.current.isExpired).toBe(true);
    expect(gone.result.current.warningLevel).toBe("critical");
  });
});

describe("an age between the moments its text changes", () => {
  /**
   * Every row of the 500-event feed redrew on each ten-second tick to print
   * the same "12m" again, about 275 ms of main thread every ten seconds.
   * Fails if a tick that leaves the text as it was draws the age again.
   */
  it("draws again only when the text it shows changes", () => {
    const now = new Date("2026-10-07T09:45:00Z").getTime();
    vi.useFakeTimers({ now });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useRealtimeAge(new Date(now - 12 * 60_000 - 5_000).toISOString());
    });
    expect(result.current).toBe("12m");
    const drawn = renders;

    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(renders).toBe(drawn);

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current).toBe("13m");
    expect(renders).toBe(drawn + 1);
  });

  /** Fails if a missing or unreadable stamp prints an empty age. */
  it("says the age is unknown where there is no stamp to read", () => {
    const { result } = renderHook(() => useRealtimeAge(null));
    expect(result.current).not.toBe("");
  });
});
