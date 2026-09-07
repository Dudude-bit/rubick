import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;
const tickers = new Set<() => void>();
let ticking: ReturnType<typeof setInterval> | null = null;

function subscribe(onTick: () => void): () => void {
  tickers.add(onTick);
  ticking ??= setInterval(() => tickers.forEach((tick) => tick()), TICK_MS);
  return () => {
    tickers.delete(onTick);
    if (tickers.size === 0 && ticking !== null) {
      clearInterval(ticking);
      ticking = null;
    }
  };
}

/**
 * The wall clock to the half minute, for "ago" labels that have to move on
 * their own. A store rather than `Date.now()` in render, which is impure
 * and would change on every re-render for no reason a reader can see.
 */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / TICK_MS) * TICK_MS
  );
}
