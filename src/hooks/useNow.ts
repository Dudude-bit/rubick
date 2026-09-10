import { useSyncExternalStore } from "react";

/** One interval per rate, shared by every reader, running only while read. */
function clock(tickMs: number): () => number {
  const tickers = new Set<() => void>();
  let ticking: ReturnType<typeof setInterval> | null = null;
  const subscribe = (onTick: () => void): (() => void) => {
    tickers.add(onTick);
    ticking ??= setInterval(() => tickers.forEach((tick) => tick()), tickMs);
    return () => {
      tickers.delete(onTick);
      if (tickers.size === 0 && ticking !== null) {
        clearInterval(ticking);
        ticking = null;
      }
    };
  };
  const snapshot = () => Math.floor(Date.now() / tickMs) * tickMs;
  return () => useSyncExternalStore(subscribe, snapshot);
}

const halfMinute = clock(30_000);
const tenth = clock(100);

/**
 * The wall clock to the half minute, for "ago" labels that have to move on
 * their own. A store rather than `Date.now()` in render, which is impure
 * and would change on every re-render for no reason a reader can see.
 */
export function useNow(): number {
  return halfMinute();
}

/**
 * The wall clock to the tenth of a second, for a counter someone is watching
 * tick. Its own rate on purpose: an elapsed time printed to one decimal from
 * `useNow` sat at "0.0 s" for thirty seconds and then jumped to "30.0". Only
 * mount something that reads this while the count is actually running.
 */
export function useNowTenths(): number {
  return tenth();
}
