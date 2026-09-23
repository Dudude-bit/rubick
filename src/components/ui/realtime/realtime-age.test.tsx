import { Profiler, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SurfaceVisibility } from "@/lib/surface-visibility";
import { RealtimeAge } from "./realtime-age";

const T0 = Date.parse("2026-09-23T12:00:00Z");

const secondsAgo = (n: number) => new Date(T0 - n * 1000).toISOString();

let commits = 0;

function cell(timestamp: string, visible = true): ReactNode {
  return (
    <SurfaceVisibility.Provider value={visible}>
      <Profiler id="age" onRender={() => commits++}>
        <RealtimeAge timestamp={timestamp} />
      </Profiler>
    </SurfaceVisibility.Provider>
  );
}

function seconds(n: number) {
  for (let i = 0; i < n; i++) act(() => vi.advanceTimersByTime(1000));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  commits = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("an age cell's clock", () => {
  /**
   * An age cell has no data of its own to change: the clock is the only
   * thing that re-renders it. Without a subscription the cell says "5s"
   * forever, and nothing else on the screen looks wrong.
   */
  it("moves on by the second while its surface is on screen", () => {
    render(cell(secondsAgo(5)));
    expect(screen.getByText("5s")).toBeInTheDocument();

    seconds(1);
    expect(screen.getByText("6s")).toBeInTheDocument();

    seconds(1);
    expect(screen.getByText("7s")).toBeInTheDocument();
  });

  /**
   * Past a minute the label reads in minutes, so it is woken every ten
   * seconds rather than every second. Waking it by the second would redraw
   * every age column in every list sixty times a minute for a digit that
   * moves once.
   */
  it("wakes an age of minutes every ten seconds, not every second", () => {
    render(cell(secondsAgo(120)));
    expect(commits).toBe(1);

    seconds(9);
    expect(commits).toBe(1);

    seconds(1);
    expect(commits).toBe(2);
  });

  /**
   * Radix force-mounts a detail tab once it has been opened, so the age
   * column of a list on a tab switched away from stays mounted. If the clock
   * ignores the surface, every one of those cells re-renders every second at
   * nobody for as long as the page is open. Shown again, it has to read the
   * clock afresh rather than carry the age it froze on.
   */
  it("stops re-rendering under a hidden surface, and catches up when shown", () => {
    const { rerender } = render(cell(secondsAgo(5), false));
    expect(commits).toBe(1);

    seconds(10);
    expect(commits).toBe(1);
    expect(screen.getByText("5s")).toBeInTheDocument();

    rerender(cell(secondsAgo(5), true));
    expect(screen.getByText("15s")).toBeInTheDocument();

    seconds(1);
    expect(screen.getByText("16s")).toBeInTheDocument();
  });
});
