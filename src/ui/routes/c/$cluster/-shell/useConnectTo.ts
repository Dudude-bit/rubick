import { useEffect, useRef } from "react";

import { useClusterStore } from "@/stores/clusterStore";

/**
 * The address names the cluster, and this is the one place a route turns
 * that into a connection. Once per cluster the address arrives at, so a
 * connect that failed is not retried in a loop: the front door, on every
 * page, says why and offers the retry.
 */
export function useConnectTo(cluster: string, ready: boolean): void {
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || asked.current === cluster) return;
    asked.current = cluster;
    const s = useClusterStore.getState();
    if (
      s.currentContext === cluster &&
      (s.isConnected || s.pendingContext === cluster)
    )
      return;
    void s.connect(cluster, { keepRoute: true });
  }, [cluster, ready]);
}
