import { useEffect, useRef } from "react";

import { useClusterStore } from "@/stores/clusterStore";

/**
 * The address names the cluster, and this is the one place a route turns
 * that into a connection. Once per cluster the address arrives at, so a
 * connect that failed is not retried in a loop: the front door, on every
 * page, says why and offers the retry.
 */
export function useConnectTo(cluster: string, ready: boolean): void {
  const arrivedAt = useRef<string | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    // Coming back is arriving again, wherever the address was meanwhile: a
    // stay at a cluster the kubeconfig lacks asks nothing, and left the
    // cluster before it remembered as asked.
    if (arrivedAt.current !== cluster) {
      arrivedAt.current = cluster;
      asked.current = false;
    }
    if (!ready || asked.current) return;
    asked.current = true;
    const s = useClusterStore.getState();
    if (
      s.currentContext === cluster &&
      (s.isConnected || s.pendingContext === cluster)
    )
      return;
    void s.connect(cluster, { keepRoute: true });
  }, [cluster, ready]);
}
