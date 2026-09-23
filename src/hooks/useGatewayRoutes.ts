/**
 * Every Gateway API route in scope, merged from one query-and-watch per
 * served kind.
 *
 * Five queries rather than one, deliberately: a watch resync replaces its
 * query's cache with the burst it delivered, so five kinds behind one key
 * would collapse to whichever kind resynced last — and two kinds may
 * legally name one route the same, which one keyspace cannot hold. The
 * merge is a render-time concern and lives here in one `useMemo`.
 */

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useGatewayApi } from "@/hooks/useGatewayApi";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useWatchedList } from "@/hooks/useWatchedList";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import {
  joinScoped,
  keepWatched,
  scopeCacheKey,
  whole,
  wireScope,
} from "@/lib/namespace-scope";
import { STALE_TIMES } from "@/lib/refresh";
import {
  ResourceType,
  toPlural,
  type ResourceKind,
} from "@/lib/resource-registry";
import type { RouteInfo, Scoped } from "@/generated/types";

export const GATEWAY_ROUTE_KINDS: ResourceKind[] = [
  ResourceType.HTTPRoute,
  ResourceType.GRPCRoute,
  ResourceType.TLSRoute,
  ResourceType.TCPRoute,
  ResourceType.UDPRoute,
];

/** One kind's list and its watch, alive only where the kind is served.
 *  The failure flag is the kind's OWN: five watches share a page, and one
 *  kind's recovery must not stop the polling that covers another's still
 *  broken stream. */
function useRouteKind(kind: ResourceKind, scope: string[], served: boolean) {
  const cacheKey = scopeCacheKey(scope);
  const wire = useMemo(() => wireScope(scope), [scope]);
  const queryKey = useMemo(
    () => queryKeys.resources(kind, cacheKey),
    [kind, cacheKey]
  );
  const { live, refresh, resyncing } = useWatchedList<RouteInfo>({
    enabled: served,
    subscribe: useCallback(
      () => commands.subscribeGatewayRouteWatch(kind, wire),
      [kind, wire]
    ),
    queryKey,
    reportFailure: toPlural(kind),
  });
  const queryClient = useQueryClient();
  const query = useLiveQuery<Scoped<RouteInfo>>({
    queryKey,
    queryFn: async () => {
      const answer = await commands.listGatewayRoutesIn(kind, wire);
      return live
        ? keepWatched(answer, queryClient.getQueryData(queryKey))
        : answer;
    },
    enabled: served,
    staleTime: STALE_TIMES.resourceList,
    // The watch feeds the cache; polling is the fallback after it fails.
    refresh,
  });
  return { kind, query, resyncing, served, live };
}

export function useGatewayRoutes(scope: string[]) {
  // The scan's own state travels with its answer. Without it a page cannot
  // tell "no routes here" from "we have not looked yet" or "we could not
  // look" — every kind query is gated on this scan, so all three arrive as
  // an empty list.
  const scan = useGatewayApi();
  const detection = scan.data;
  const served = useMemo(
    () => new Set(detection?.kinds.map((k) => k.kind) ?? []),
    [detection]
  );

  // Five fixed calls, not a loop: the kinds are a closed set and hooks
  // must not be conditional. A kind the cluster does not serve costs
  // nothing — its query and watch stay disabled.
  const http = useRouteKind(
    GATEWAY_ROUTE_KINDS[0],
    scope,
    served.has(GATEWAY_ROUTE_KINDS[0])
  );
  const grpc = useRouteKind(
    GATEWAY_ROUTE_KINDS[1],
    scope,
    served.has(GATEWAY_ROUTE_KINDS[1])
  );
  const tls = useRouteKind(
    GATEWAY_ROUTE_KINDS[2],
    scope,
    served.has(GATEWAY_ROUTE_KINDS[2])
  );
  const tcp = useRouteKind(
    GATEWAY_ROUTE_KINDS[3],
    scope,
    served.has(GATEWAY_ROUTE_KINDS[3])
  );
  const udp = useRouteKind(
    GATEWAY_ROUTE_KINDS[4],
    scope,
    served.has(GATEWAY_ROUTE_KINDS[4])
  );

  const kinds = useMemo(
    () => [http, grpc, tls, tcp, udp],
    [http, grpc, tls, tcp, udp]
  );
  const active = kinds.filter((entry) => entry.served);
  // One answer from five: a namespace any kind could not read is unread for
  // the page, and the rows beside it are not the scope's whole.
  const { rows: routes, unread } = useMemo(
    () =>
      joinScoped(
        kinds
          .filter((entry) => entry.served)
          .map((entry) => entry.query.data ?? whole<RouteInfo>([]))
      ),
    [kinds]
  );

  // A kind that failed whole — refused in every namespace, or on a scope read
  // in one call — has no rows to join and no namespace to name, and adding it
  // as `whole([])` counted a kind nobody could read as a kind with no routes.
  const refusedKinds = active.flatMap((entry) =>
    entry.query.isError && entry.query.data === undefined
      ? [{ kind: entry.kind, error: entry.query.error }]
      : []
  );

  return {
    detection,
    detectionLoading: scan.isLoading,
    detectionError: (scan.error as Error | null) ?? null,
    served,
    routes,
    unread,
    refusedKinds,
    isLoading:
      active.length > 0 && active.some((entry) => entry.query.isLoading),
    // An error only speaks when it hides rows: one kind failing while four
    // answer is the freshness reading's business, not a page-wide error.
    error:
      active.length > 0 && active.every((entry) => entry.query.isError)
        ? (active[0].query.error as Error)
        : null,
    dataUpdatedAt: Math.max(
      0,
      ...active.map((entry) => entry.query.dataUpdatedAt ?? 0)
    ),
    live: active.length > 0 && active.every((entry) => entry.live),
    resyncing: active.some((entry) => entry.resyncing),
  };
}
