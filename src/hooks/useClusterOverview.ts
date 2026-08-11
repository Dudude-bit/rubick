import { keepPreviousData } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * The cluster overview query, shared by everything that reads it.
 *
 * The scope is the cache key, so the sidebar counts, the overview page and
 * the window chrome all read one response per scope rather than issuing the
 * same request three times every two seconds.
 *
 * `namespace` is the scope to ask for: `null` means the whole cluster.
 */
export function useClusterOverview(namespace: string | null) {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);

  return useLiveQuery({
    queryKey: ["cluster-overview", currentContext, namespace ?? ""],
    queryFn: async () => {
      try {
        return await commands.getClusterOverview(namespace || null);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: isConnected,
    staleTime: STALE_TIMES.overview,
    placeholderData: keepPreviousData,
    refresh: "overview",
  });
}
