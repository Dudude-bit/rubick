import { useMemo } from "react";

import type { GatewayInfo } from "@/generated/types";
import { useDoorAsk } from "@/hooks/useDoorAsk";
import { useGatewayApi } from "@/hooks/useGatewayApi";
import { oneLock, useListLocks, type Lock } from "@/hooks/useListAccess";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useT } from "@/i18n/useT";
import { backingFrom, ROUTING_STALE, useBackingLists } from "@/integrations";
import { commands } from "@/lib/commands";
import { errorCode, errorToShow } from "@/lib/error-utils";
import {
  inScope,
  joinScoped,
  scopeCacheKey,
  wireScope,
} from "@/lib/namespace-scope";
import { EVERY_NAMESPACE, queryKeys } from "@/lib/query-keys";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import {
  GATEWAY_ROUTE_KINDS,
  routesBoard,
  type RouteKindRefused,
  type RoutesBoard,
} from "@/lib/route-rows";
import { useLocale } from "@/stores/localeStore";

const boards = new Map<
  string,
  { inputs: readonly unknown[]; board: RoutesBoard }
>();

/**
 * One board per scope for every reader of it. The rail and each attention
 * count read the same answers, and tracing every route once per reader
 * multiplied the one sweep that grows with the cluster.
 */
function sharedBoard(
  key: string,
  inputs: readonly unknown[],
  compute: () => RoutesBoard
): RoutesBoard {
  const last = boards.get(key);
  if (last && inputs.every((input, at) => Object.is(input, last.inputs[at])))
    return last.board;
  const board = compute();
  boards.set(key, { inputs, board });
  return board;
}

/**
 * Every Gateway API route in `scope` traced to its verdict, and the Gateways
 * in it, as the rail's marks and the attention count both read them.
 */
export function useRoutesBoard(scope: readonly string[], enabled = true) {
  const t = useT();
  const locale = useLocale();
  const detection = useGatewayApi().data;
  const installed = enabled && (detection?.installed ?? false);
  const served = useMemo(
    () => new Set(detection?.kinds.map((k) => k.kind) ?? []),
    [detection]
  );
  // Constructed exactly the way GatewayDetail constructs it, so the two
  // share one cache entry rather than fetching the same lists twice.
  const routeKinds = useMemo(
    () =>
      (detection?.kinds ?? [])
        .map((kind) => kind.kind)
        .filter((kind) =>
          (GATEWAY_ROUTE_KINDS as readonly string[]).includes(kind)
        ),
    [detection]
  );

  // The authorizer's word on our rows, same as every row above them.
  const locks = useListLocks([
    ...(served.has("Gateway") ? [ResourceType.Gateway] : []),
    ...(routeKinds as ResourceKind[]),
  ]);
  // These pages find each kind through discovery, which every signed-in
  // reader may read, so the list reviews are the whole question.
  const gatewaysLock = locks[ResourceType.Gateway];
  const gatewaysDenied = gatewaysLock !== undefined;
  const routeLocks = routeKinds.flatMap((kind) => {
    const lock = locks[kind as ResourceKind];
    return lock ? [lock] : [];
  });
  const routesLock: Lock | undefined =
    routeKinds.length > 0 && routeLocks.length === routeKinds.length
      ? oneLock(routeLocks)
      : undefined;

  const cacheKey = scopeCacheKey(scope);

  // Verdict sources, read cluster-wide on purpose: a route can attach to a
  // Gateway (or a GatewayClass) in a namespace the window is not on, and a
  // verdict computed without it is wrong. These are the same keys the routes
  // list and the trace read, so the pages share the answer. A namespace-scoped
  // token is refused them — the board reads that absence as `topologyKnown:
  // false` and asserts only the breaks it read, never one it cannot see.
  const gatewaysAll = useLiveQuery({
    queryKey: queryKeys.gateways(),
    queryFn: () => commands.listGateways(null),
    staleTime: ROUTING_STALE,
    refresh: "overview",
    enabled: installed && served.has("Gateway") && !gatewaysDenied,
  });
  const classes = useLiveQuery({
    queryKey: queryKeys.gatewayClasses(),
    queryFn: commands.listGatewayClasses,
    staleTime: ROUTING_STALE,
    refresh: "overview",
    enabled: installed && served.has("GatewayClass"),
  });
  // The rail's own count follows the window's namespaces, like every other
  // row — read per namespace so a token with rights in some and not the whole
  // cluster still gets a number instead of a blank (the routes page reads the
  // same way). A whole-cluster window is one call per kind.
  const routes = useLiveQuery({
    queryKey: [
      "gateway-rail-routes",
      cacheKey ?? EVERY_NAMESPACE,
      ...routeKinds,
    ],
    queryFn: async () => {
      // Each served kind on its own: a token may list HTTPRoutes and not
      // TCPRoutes, and the rows of the kinds that answered still feed the
      // mark. A refused kind is not a kind with no routes, though, so the
      // count stays blank beside one, as it does beside an unread namespace
      // and as the routes page does. Every kind refused is the refusal.
      const settled = await Promise.allSettled(
        routeKinds.map((kind) =>
          commands.listGatewayRoutesIn(kind, wireScope(scope))
        )
      );
      const answered = settled.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : []
      );
      const refused = settled.flatMap((r, at): RouteKindRefused[] =>
        r.status === "rejected"
          ? [
              {
                kind: routeKinds[at],
                code: errorCode(r.reason),
                message: errorToShow(r.reason),
              },
            ]
          : []
      );
      if (refused.length > 0 && answered.length === 0) {
        throw (settled[0] as PromiseRejectedResult).reason;
      }
      return {
        ...joinScoped(answered),
        complete: refused.length === 0,
        refused,
      };
    },
    staleTime: ROUTING_STALE,
    refresh: "overview",
    enabled: installed && routeKinds.length > 0 && !routesLock,
  });
  // Gateways for the COUNT, scoped like the routes. The cluster-wide read above
  // stays the verdict source; on a whole-cluster window it already is this
  // list, so this second read only runs once a namespace is selected.
  const gatewaysScoped = useLiveQuery({
    queryKey: ["gateway-rail-gateways", cacheKey ?? EVERY_NAMESPACE],
    queryFn: () => commands.listGatewaysIn(wireScope(scope)),
    staleTime: ROUTING_STALE,
    refresh: "overview",
    enabled:
      installed && served.has("Gateway") && !gatewaysDenied && scope.length > 0,
  });
  const backing = useBackingLists(
    installed && routeKinds.length > 0 && !routesLock
  );
  const door = useDoorAsk(installed && routeKinds.length > 0 && !routesLock);

  const classesSettled =
    classes.data !== undefined || !served.has("GatewayClass");
  const topologyKnown = gatewaysAll.data !== undefined && classesSettled;
  // The count follows the scope; on a whole-cluster window the verdict read
  // already is that list, so reuse it and skip the second fetch.
  const counted: GatewayInfo[] | undefined =
    scope.length === 0 ? gatewaysAll.data : gatewaysScoped.data?.rows;
  const scopedGateways = useMemo(
    () => (counted ?? []).filter((g) => inScope(scope, g.namespace)),
    [counted, scope]
  );
  // The subject list is scoped, and read that way rather than narrowed from
  // a cluster-wide list, so an RBAC token that cannot list cluster-wide still
  // gets its own namespaces' rows.
  const scopedRoutes = useMemo(
    () => (routes.data?.rows ?? []).filter((r) => inScope(scope, r.namespace)),
    [routes.data, scope]
  );
  const board = useMemo(
    () =>
      sharedBoard(
        cacheKey ?? EVERY_NAMESPACE,
        [
          routes.data,
          gatewaysAll.data,
          classes.data,
          backing.data,
          backing.error,
          topologyKnown,
          door,
          locale,
        ],
        () =>
          routesBoard(
            scopedRoutes,
            {
              gateways: gatewaysAll.data ?? [],
              classes: classes.data ?? [],
              // Classes count as read only once their list answered (or the
              // kind is not served at all) — a gateway judged against an
              // empty class list reads "class does not exist", which would
              // put a red dot on a healthy cluster for one render.
              topologyKnown,
              backing: backingFrom(backing.data, backing.error),
              door,
            },
            t
          )
      ),
    [
      cacheKey,
      routes.data,
      gatewaysAll.data,
      classes.data,
      backing.data,
      backing.error,
      topologyKnown,
      door,
      locale,
      scopedRoutes,
      t,
    ]
  );
  const scopedPulse = useMemo(
    () => board.pulse.filter((p) => inScope(scope, p.namespace)),
    [board, scope]
  );

  return {
    installed,
    served,
    routeKinds,
    gatewaysLock,
    routesLock,
    gatewaysAll,
    gatewaysScoped,
    classes,
    routes,
    backingError: backing.error,
    topologyKnown,
    counted,
    scopedRoutes,
    scopedGateways,
    board,
    scopedPulse,
  };
}
