import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { knownOf, type Known } from "@/lib/known";
import { listPodRows } from "@/lib/pod-rows";
import type { LabeledNamespace, LabeledPod } from "@/lib/policy-peers";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";

export interface PeerData {
  /** The pods of the policy's own namespace. */
  home: Known<LabeledPod[]>;
  /** Every pod in the cluster, read only when a peer leaves the namespace. */
  cluster: Known<LabeledPod[]>;
  namespaces: Known<LabeledNamespace[]>;
}

/**
 * What resolving a policy's selectors needs, from the caches the Pods list
 * and the namespace picker already fill. The cluster-wide reads happen only
 * when a peer reaches past the policy's own namespace.
 */
export function usePolicyPeerData(
  namespace: string | null | undefined,
  { cluster = false, namespaces = false } = {}
): PeerData {
  const home = useQuery({
    queryKey: queryKeys.podRows(namespace),
    // The Pods list's own entry, so it keeps the list's shape.
    queryFn: ({ signal }) => listPodRows([namespace!], signal),
    select: (read): LabeledPod[] => read.rows,
    enabled: !!namespace,
    staleTime: STALE_TIMES.resourceList,
  });
  const everywhere = useQuery({
    queryKey: queryKeys.podRows(null),
    queryFn: ({ signal }) => listPodRows(null, signal),
    select: (read): LabeledPod[] => read.rows,
    enabled: cluster,
    staleTime: STALE_TIMES.resourceList,
  });
  const listed = useQuery({
    queryKey: queryKeys.namespaces(),
    queryFn: () => commands.listNamespaces(),
    enabled: namespaces,
    staleTime: STALE_TIMES.slow,
  });
  return {
    home: knownOf(home),
    cluster: knownOf(everywhere),
    namespaces: knownOf(listed),
  };
}
