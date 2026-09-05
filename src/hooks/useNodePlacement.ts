import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { nodePlacement, type NodePlacement } from "@/lib/node-pool";
import { STALE_TIMES } from "@/lib/refresh";

/**
 * What the node under an object says about itself.
 *
 * The join is here rather than on the wire: carrying `spot` on `PodInfo`
 * would make every pod list — the hottest path there is — fetch a node list
 * for a fact wanted on one detail page, and in a namespace of three hundred
 * pods mostly copy the same answer three hundred times, over labels that
 * change with pool edits rather than pod restarts.
 *
 * The key is the one `useResourceDetail` builds for a cluster-scoped kind, so
 * this shares its cache with the Node page: opening five pods on one node is
 * one request, and arriving from that node's page is none.
 */
export function useNodePlacement(
  nodeName: string | null | undefined
): NodePlacement | null {
  const { data } = useQuery({
    queryKey: ["node", undefined, nodeName],
    queryFn: () => commands.getNode(nodeName as string),
    enabled: !!nodeName,
    staleTime: STALE_TIMES.resourceDetail,
  });
  return data ? nodePlacement(data) : null;
}
