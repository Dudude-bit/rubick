/**
 * What one CRD scan says about Gateway API in the connected cluster.
 *
 * One query per cluster, deliberately — the same contract the vendor scan
 * holds: sidebar rows, pages and the traffic chain all read this cached
 * answer, and none of them re-checks on its own. Keyed on the context so
 * cluster B never reads cluster A's scan; gated on the connection standing
 * for the same reason the vendor scan is (see `useDetected`) — firing
 * before the client exists buys errored queries and their backoff on every
 * launch.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";

/** A minute-scale cache: CRD bundles change with an install, not by the second. */
const GATEWAY_API_STALE = 5 * 60_000;

export function useGatewayApi() {
  const isConnected = useClusterStore((state) => state.isConnected);
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: ["gateway-api", context],
    queryFn: commands.detectGatewayApi,
    staleTime: GATEWAY_API_STALE,
    enabled: isConnected && context !== null,
  });
}
