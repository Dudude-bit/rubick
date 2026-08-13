/**
 * Hook for fetching cluster information
 *
 * Provides cluster info including Kubernetes version, platform, etc.
 * Data is cached and shared across components using the same query key.
 *
 * @module hooks/useClusterInfo
 */

import { keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { normalizeTauriError } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQuery } from "@/hooks/useLiveQuery";

export function useClusterInfo() {
  const { isConnected, currentContext } = useClusterStore();

  return useLiveQuery({
    queryKey: ["cluster-info", currentContext],
    queryFn: async () => {
      if (!currentContext) return null;
      try {
        return await commands.getClusterInfo(currentContext);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: isConnected && !!currentContext,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.overview,
    // No rate, because there is no question to re-ask: this is the
    // apiserver's own `/version`, and it cannot change under a live
    // connection — an upgraded control plane is a new connection, which
    // this query is keyed on. It rode the `overview` rate purely by
    // habit, spending a round trip every ten seconds to be told the same
    // version string. Coming back to the app still refetches it, so a
    // reconnect cannot leave a stale version on screen.
    refresh: false,
  });
}
