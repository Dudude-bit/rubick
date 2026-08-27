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

import { useCallback, useMemo, useState } from "react";

import { useGatewayApi } from "@/hooks/useGatewayApi";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useToast } from "@/components/ui/use-toast";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import type { RouteInfo } from "@/generated/types";

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
function useRouteKind(
  kind: ResourceKind,
  namespace: string | null,
  served: boolean,
  onWatchError: (kind: string, message: string) => void
) {
  const [watchFailed, setWatchFailed] = useState(false);
  const queryKey = useMemo(
    () => ["gateway-routes", kind, namespace ?? "all"],
    [kind, namespace]
  );
  const query = useLiveQuery<RouteInfo[]>({
    queryKey,
    queryFn: () => commands.listGatewayRoutes(kind, namespace),
    enabled: served,
    staleTime: STALE_TIMES.resourceList,
    // The watch feeds the cache; polling is only the fallback after it
    // fails, same contract as every watched list page.
    refresh: watchFailed ? "resourceList" : false,
  });
  const { resyncing } = useResourceWatch<RouteInfo>({
    enabled: served,
    subscribe: useCallback(
      () => commands.subscribeGatewayRouteWatch(kind, namespace),
      [kind, namespace]
    ),
    queryKey,
    onError: useCallback(
      (message: string) => {
        setWatchFailed((failed) => {
          if (!failed) onWatchError(kind, message);
          return true;
        });
      },
      [kind, onWatchError]
    ),
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });
  return { query, resyncing, served, watchFailed };
}

export function useGatewayRoutes(namespace: string | null) {
  const { toast } = useToast();
  const t = useT();
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

  const onWatchError = useCallback(
    (kind: string, message: string) => {
      toast({
        title: t("action", "liveUnavailableFor", { kind }),
        description: t("action", "fallsBackPolling", { message }),
      });
    },
    [toast, t]
  );

  // Five fixed calls, not a loop: the kinds are a closed set and hooks
  // must not be conditional. A kind the cluster does not serve costs
  // nothing — its query and watch stay disabled.
  const http = useRouteKind(
    GATEWAY_ROUTE_KINDS[0],
    namespace,
    served.has(GATEWAY_ROUTE_KINDS[0]),
    onWatchError
  );
  const grpc = useRouteKind(
    GATEWAY_ROUTE_KINDS[1],
    namespace,
    served.has(GATEWAY_ROUTE_KINDS[1]),
    onWatchError
  );
  const tls = useRouteKind(
    GATEWAY_ROUTE_KINDS[2],
    namespace,
    served.has(GATEWAY_ROUTE_KINDS[2]),
    onWatchError
  );
  const tcp = useRouteKind(
    GATEWAY_ROUTE_KINDS[3],
    namespace,
    served.has(GATEWAY_ROUTE_KINDS[3]),
    onWatchError
  );
  const udp = useRouteKind(
    GATEWAY_ROUTE_KINDS[4],
    namespace,
    served.has(GATEWAY_ROUTE_KINDS[4]),
    onWatchError
  );

  const kinds = useMemo(
    () => [http, grpc, tls, tcp, udp],
    [http, grpc, tls, tcp, udp]
  );
  const active = kinds.filter((entry) => entry.served);
  const routes = useMemo(
    () =>
      kinds
        .filter((entry) => entry.served)
        .flatMap((entry) => entry.query.data ?? []),
    [kinds]
  );

  return {
    detection,
    detectionLoading: scan.isLoading,
    detectionError: (scan.error as Error | null) ?? null,
    served,
    routes,
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
    live: active.length > 0 && !active.some((entry) => entry.watchFailed),
    resyncing: active.some((entry) => entry.resyncing),
  };
}
