import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";

/** The node's own read, under the key its page reads it by: one request for every reader of one node. */
export function useNodeRead(name: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.detail(ResourceType.Node, null, name ?? undefined),
    queryFn: () => commands.getNode(name as string),
    enabled: !!name,
    staleTime: STALE_TIMES.resourceDetail,
    retry: false,
  });
}
