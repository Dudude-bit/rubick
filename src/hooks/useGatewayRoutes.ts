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
import { listAcrossScope, scopeCacheKey } from "@/lib/namespace-scope";
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
  scope: string[],
  served: boolean,
  onWatchError: (kind: string, message: string) => void
) {
  const [watchFailed, setWatchFailed] = useState(false);
  // Several namespaces are read one apiece and polled; a watch covers none or
  // one. See `listAcrossScope`.
  const several = scope.length >= 2;
  const cacheKey = scopeCacheKey(scope);
  const watchNamespace = scope.length === 1 ? scope[0] : null;
  const queryKey = useMemo(
    () => ["gateway-routes", kind, cacheKey ?? "all"],
    [kind, cacheKey]
  );
  const query = useLiveQuery<RouteInfo[]>({
    queryKey,
    queryFn: listAcrossScope(scope, (ns) =>
      commands.listGatewayRoutes(kind, ns)
    ),
    enabled: served,
    staleTime: STALE_TIMES.resourceList,
    // The watch feeds the cache; polling is the fallback after it fails, and
    // the mode for a multi-namespace scope (no cluster-wide watch).
    refresh: watchFailed || several ? "resourceList" : false,
  });
  const { resyncing } = useResourceWatch<RouteInfo>({
    enabled: served && !several,
    subscribe: useCallback(
      () => commands.subscribeGatewayRouteWatch(kind, watchNamespace),
      [kind, watchNamespace]
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
  return { query, resyncing, served, watchFailed, several };
}

export function useGatewayRoutes(scope: string[]) {
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
    scope,
    served.has(GATEWAY_ROUTE_KINDS[0]),
    onWatchError
  );
  const grpc = useRouteKind(
    GATEWAY_ROUTE_KINDS[1],
    scope,
    served.has(GATEWAY_ROUTE_KINDS[1]),
    onWatchError
  );
  const tls = useRouteKind(
    GATEWAY_ROUTE_KINDS[2],
    scope,
    served.has(GATEWAY_ROUTE_KINDS[2]),
    onWatchError
  );
  const tcp = useRouteKind(
    GATEWAY_ROUTE_KINDS[3],
    scope,
    served.has(GATEWAY_ROUTE_KINDS[3]),
    onWatchError
  );
  const udp = useRouteKind(
    GATEWAY_ROUTE_KINDS[4],
    scope,
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
    // A multi-namespace scope polls rather than watches, so it is not "live"
    // even though no watch failed.
    live:
      active.length > 0 &&
      !active.some((entry) => entry.watchFailed || entry.several),
    resyncing: active.some((entry) => entry.resyncing),
  };
}
