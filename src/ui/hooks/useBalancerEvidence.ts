import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { balancerEvidence, type BalancerEvidence } from "@/lib/load-balancer";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";

/** A minute: an implementation does not come and go by the second. */
const STALE = 60_000;

/**
 * Whether any LoadBalancer Service in the cluster has an address, read only
 * while one without an address is on screen. The Services list's own cache
 * entry for the whole cluster, so the two never read it twice.
 */
export function useBalancerEvidence(enabled: boolean): BalancerEvidence {
  const read = useQuery({
    queryKey: queryKeys.resources(ResourceType.Service, null),
    queryFn: () => commands.listServicesIn(null),
    staleTime: STALE,
    enabled,
  });
  return balancerEvidence(read.data?.rows, read.error);
}
