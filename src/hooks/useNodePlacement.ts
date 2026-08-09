import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { nodePlacement, type NodePlacement } from "@/lib/node-pool";
import { STALE_TIMES } from "@/lib/refresh";

/**
 * What the node under an object says about itself.
 *
 * The join is here rather than on the wire on purpose. Carrying `spot` on
 * `PodInfo` would mean every pod list in the app fetching a node list to
 * build it, and the pod list is the hottest path there is — a namespace of
 * three hundred pods would pay for a fact wanted on one detail page. A node's
 * labels also change on a timescale of pool edits, not pod restarts, so
 * pinning them into a pod's payload would mostly be copying the same answer
 * three hundred times.
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
