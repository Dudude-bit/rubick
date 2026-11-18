import { useClusterStore } from "@/stores/clusterStore";

/**
 * `read`, shared by every call made in one cluster while it is in flight.
 *
 * A capability answers per object and reads the whole cluster to do it, so a
 * map asking about forty Services at once read the cluster's routing forty
 * times over: four hundred lists in two seconds, and every other read on the
 * cluster waiting behind them. A call after it settles reads again.
 */
export function inFlightOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let held: { context: string | null; answer: Promise<T> } | null = null;
  return () => {
    const context = useClusterStore.getState().currentContext;
    if (held?.context === context) return held.answer;
    const mine = { context, answer: read() };
    held = mine;
    const settled = () => {
      if (held === mine) held = null;
    };
    mine.answer.then(settled, settled);
    return mine.answer;
  };
}
