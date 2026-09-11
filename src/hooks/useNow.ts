import { useSyncExternalStore } from "react";

/** Nothing to subscribe to: a clock a component has asked not to be woken by. */
const stopped = () => () => {};

/** One interval per rate, shared by every reader, running only while read. */
function clock(tickMs: number): (live: boolean) => number {
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
  return (live: boolean) =>
    useSyncExternalStore(live ? subscribe : stopped, snapshot);
}

const halfMinute = clock(30_000);
const second = clock(1_000);
const tenth = clock(100);

/**
 * The wall clock to the half minute, for "ago" labels that have to move on
 * their own. A store rather than `Date.now()` in render, which is impure
 * and would change on every re-render for no reason a reader can see.
 */
export function useNow(): number {
  return halfMinute(true);
}

/**
 * The wall clock to the tenth of a second, for a counter someone is watching
 * tick. Its own rate on purpose: an elapsed time printed to one decimal from
 * `useNow` sat at "0.0 s" for thirty seconds and then jumped to "30.0".
 *
 * Pass `live: false` — from `useSurfaceVisible` — and it stops waking the
 * component. Radix force-mounts a detail tab once it has been opened, so a
 * counter on a tab switched away from went on re-rendering ten times a
 * second at nobody for as long as the page stayed open.
 */
export function useNowTenths(live = true): number {
  return tenth(live);
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
  return second(live);
}
