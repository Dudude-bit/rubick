import { useSyncExternalStore } from "react";

import { useSurfaceVisible } from "@/lib/surface-visibility";
import { useWindowActivity } from "@/lib/window-activity";

interface Clock {
  subscribe: (onTick: () => void) => () => void;
  snapshot: () => number;
}

/** Nothing to subscribe to: a clock a component has asked not to be woken by. */
const stopped = () => () => {};

/** One interval per rate, shared by every reader, running only while read. */
function clock(tickMs: number): Clock {
  const tickers = new Set<() => void>();
  let ticking: ReturnType<typeof setInterval> | null = null;
  return {
    subscribe: (onTick) => {
      tickers.add(onTick);
      ticking ??= setInterval(() => tickers.forEach((tick) => tick()), tickMs);
      return () => {
        tickers.delete(onTick);
        if (tickers.size === 0 && ticking !== null) {
          clearInterval(ticking);
          ticking = null;
        }
      };
    },
    snapshot: () => Math.floor(Date.now() / tickMs) * tickMs,
  };
}

const halfMinute = clock(30_000);
const tenth = clock(100);

/**
 * The rates an age or a countdown moves at: by the second while it reads in
 * seconds, every ten seconds while it reads in minutes, by the minute after.
 */
const EVERY = {
  1_000: clock(1_000),
  10_000: clock(10_000),
  60_000: clock(60_000),
} as const;

export type Every = keyof typeof EVERY;

/**
 * Every clock here stops waking a component whose surface or window is
 * hidden, as well as one that passed `live: false`. Radix force-mounts a
 * detail tab once it has been opened, so an age cell on a tab switched away from went on
 * re-rendering every second at nobody for as long as the page stayed open.
 * Shown again, the surface re-renders and reads the clock afresh.
 */
function useClock(rate: Clock, live: boolean): number {
  const surfaceVisible = useSurfaceVisible();
  const windowVisible = useWindowActivity((state) => state.visible);
  return useSyncExternalStore(
    live && surfaceVisible && windowVisible ? rate.subscribe : stopped,
    rate.snapshot
  );
}

/**
 * The wall clock to the half minute, for "ago" labels that have to move on
 * their own. A store rather than `Date.now()` in render, which is impure
 * and would change on every re-render for no reason a reader can see.
 */
export function useNow(live = true): number {
  return useClock(halfMinute, live);
}

/**
 * The wall clock to the tenth of a second, for a counter someone is watching
 * tick. Its own rate on purpose: an elapsed time printed to one decimal from
 * `useNow` sat at "0.0 s" for thirty seconds and then jumped to "30.0".
 */
export function useNowTenths(live = true): number {
  return useClock(tenth, live);
}

/**
 * The wall clock to the second, for a wait somebody is sitting through.
 *
 * Between the two above on purpose: a skeleton that has been one for
 * fourteen seconds should say fourteen, and a tenth-of-a-second clock would
 * wake every list on the page for a number nobody reads that finely. Pass
 * `live: false` the moment there is nothing to wait for.
 */
export function useNowSeconds(live = true): number {
  return useClock(EVERY[1_000], live);
}

/** The wall clock at a rate the caller picks per render, for an age or a countdown. */
export function useNowEvery(every: Every, live = true): number {
  return useClock(EVERY[every], live);
}
