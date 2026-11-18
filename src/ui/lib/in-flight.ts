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
  // Per cluster: one switched to and back finds its own read still going.
  const held = new Map<string | null, Promise<T>>();
  return () => {
    const context = useClusterStore.getState().currentContext;
    const going = held.get(context);
    if (going) return going;
    const answer = read();
    held.set(context, answer);
    const settled = () => {
      if (held.get(context) === answer) held.delete(context);
    };
    answer.then(settled, settled);
    return answer;
  };
}
