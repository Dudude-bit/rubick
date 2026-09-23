import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import type { SavedConnection } from "../registry";

/** What is saved for this vendor, in the shape every connected vendor reads. */
export async function readSavedConnection(): Promise<SavedConnection | null> {
  const connection = await commands.getPrometheusConnection();
  if (!connection) return null;
  return {
    url: connection.url,
    authType: connection.authType === "bearer" ? "bearer" : "none",
    hasToken: connection.hasToken,
    insecureTls: connection.insecureTls,
  };
}

/**
 * The saved address, for links into the Prometheus UI. The settings row's own
 * entry, so saving a new address there moves every link at once.
 */
export function useSavedConnection(staleTime: number) {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: queryKeys.integrationConnection("prometheus", context),
    queryFn: readSavedConnection,
    staleTime,
  });
}
