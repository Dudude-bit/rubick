/**
 * Every Gateway API route in scope, one list — because the reader's
 * question is "what routes into this cluster", not "which of five kinds am
 * I in". The kinds stay first-class everywhere else: a row says its kind,
 * opens its kind's detail page, and deletes as its kind.
 *
 * Five queries rather than one, deliberately. A watch resync replaces its
 * query's cache with the burst it just delivered, so five kinds behind one
 * key would collapse to whichever kind resynced last — and two kinds may
 * name one route the same, which one keyspace cannot hold. The merge is a
 * render-time concern, so it lives here in a `useMemo` and nowhere else.
 */

import { useCallback, useMemo, useState } from "react";
import { Eye, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { ResourceList } from "./ResourceList";
import {
  createAgeColumn,
  createNameColumn,
  createNamespaceColumn,
} from "./columns";
import { useGatewayApi } from "@/hooks/useGatewayApi";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import type { QuickAction } from "@/components/ui/quick-actions";
import type { ColumnDef } from "@tanstack/react-table";
import type { RouteInfo } from "@/generated/types";

const ROUTE_KINDS: ResourceKind[] = [
  ResourceType.HTTPRoute,
  ResourceType.GRPCRoute,
  ResourceType.TLSRoute,
  ResourceType.TCPRoute,
  ResourceType.UDPRoute,
];

/**
 * What the controllers said, reduced honestly: every parent verdict that
 * exists, and "no controller answered" where none does — which is not the
 * same row as "accepted".
 */
function acceptance(route: RouteInfo): {
  text: string;
  tone: "ok" | "err" | "mute";
} {
  const verdicts = route.parents.flatMap((parent) =>
    parent.conditions.filter((c) => c.type === "Accepted")
  );
  if (verdicts.length === 0) {
    return { text: "no controller answered", tone: "mute" };
  }
  const refused = verdicts.find((c) => c.status === "False");
  if (refused) {
    return { text: refused.reason ?? "refused", tone: "err" };
  }
  if (verdicts.every((c) => c.status === "True")) {
    return { text: "accepted", tone: "ok" };
  }
  return { text: "unknown", tone: "mute" };
}

const TONE_CLASS = {
  ok: "text-ok",
  err: "text-err",
  mute: "text-fg-fnt",
} as const;

/** `a.example.com +2`, or the honest blank for the kinds with no hostnames. */
function hostsCell(hostnames: string[]): string {
  if (hostnames.length === 0) return "—";
  if (hostnames.length === 1) return hostnames[0];
  return `${hostnames[0]} +${hostnames.length - 1}`;
}

/** Parent names — a `kind: Service` parent is a mesh attachment, said so. */
function parentsCell(route: RouteInfo): string {
  if (route.parentRefs.length === 0) return "—";
  return route.parentRefs
    .map((p) => (p.kind === "Gateway" ? p.name : `${p.name} (mesh)`))
    .join(", ");
}

/** One kind's list and its watch, alive only where the kind is served. */
function useRouteKind(
  kind: ResourceKind,
  namespace: string | null,
  served: boolean,
  watchFailed: boolean,
  onWatchError: (kind: string, message: string) => void,
  onWatchRecovered: () => void
) {
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
      (message: string) => onWatchError(kind, message),
      [kind, onWatchError]
    ),
    onRecovered: onWatchRecovered,
  });
  return { query, resyncing, served };
}

export function GatewayRoutesList() {
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const navigate = useNavigate();
  const { toast } = useToast();
  const detection = useGatewayApi().data;
  const served = new Set(detection?.kinds.map((k) => k.kind) ?? []);

  const [watchFailed, setWatchFailed] = useState(false);
  const onWatchError = useCallback(
    (kind: string, message: string) => {
      setWatchFailed((failed) => {
        if (!failed) {
          toast({
            title: `Live updates unavailable for ${kind}s`,
            description: `${message} — the list falls back to polling.`,
          });
        }
        return true;
      });
    },
    [toast]
  );
  const onWatchRecovered = useCallback(() => setWatchFailed(false), []);

  // Five fixed calls, not a loop: the kinds are a closed set and hooks
  // must not be conditional. A kind the cluster does not serve costs
  // nothing — its query and watch stay disabled.
  const kinds = [
    useRouteKind(
      ROUTE_KINDS[0],
      currentNamespace,
      served.has(ROUTE_KINDS[0]),
      watchFailed,
      onWatchError,
      onWatchRecovered
    ),
    useRouteKind(
      ROUTE_KINDS[1],
      currentNamespace,
      served.has(ROUTE_KINDS[1]),
      watchFailed,
      onWatchError,
      onWatchRecovered
    ),
    useRouteKind(
      ROUTE_KINDS[2],
      currentNamespace,
      served.has(ROUTE_KINDS[2]),
      watchFailed,
      onWatchError,
      onWatchRecovered
    ),
    useRouteKind(
      ROUTE_KINDS[3],
      currentNamespace,
      served.has(ROUTE_KINDS[3]),
      watchFailed,
      onWatchError,
      onWatchRecovered
    ),
    useRouteKind(
      ROUTE_KINDS[4],
      currentNamespace,
      served.has(ROUTE_KINDS[4]),
      watchFailed,
      onWatchError,
      onWatchRecovered
    ),
  ];

  const active = kinds.filter((entry) => entry.served);
  const [http, grpc, tls, tcp, udp] = kinds;
  const routes = useMemo(
    () =>
      [http, grpc, tls, tcp, udp]
        .filter((entry) => entry.served)
        .flatMap((entry) => entry.query.data ?? []),
    [http, grpc, tls, tcp, udp]
  );
  const isLoading =
    active.length > 0 && active.some((entry) => entry.query.isLoading);
  // An error only speaks when it hides rows: one kind failing while four
  // answer is the freshness reading's business, not a page-wide error.
  const error =
    active.length > 0 && active.every((entry) => entry.query.isError)
      ? (active[0].query.error as Error)
      : null;
  const dataUpdatedAt = Math.max(
    0,
    ...active.map((entry) => entry.query.dataUpdatedAt ?? 0)
  );

  const columns: ColumnDef<RouteInfo>[] = [
    {
      id: "kind",
      header: "Kind",
      size: 110,
      accessorKey: "kind",
      cell: ({ row }) => (
        <span className="text-fg-fnt">{row.original.kind}</span>
      ),
    },
    createNameColumn<RouteInfo>(ResourceType.HTTPRoute),
    createNamespaceColumn<RouteInfo>(),
    {
      id: "hostnames",
      header: "Hostnames",
      size: 220,
      accessorFn: (route) => route.hostnames.join(","),
      cell: ({ row }) => (
        <span className="truncate">{hostsCell(row.original.hostnames)}</span>
      ),
    },
    {
      id: "parents",
      header: "Attaches to",
      size: 180,
      cell: ({ row }) => (
        <span className="truncate">{parentsCell(row.original)}</span>
      ),
    },
    {
      id: "accepted",
      header: "Accepted",
      size: 170,
      cell: ({ row }) => {
        const said = acceptance(row.original);
        return <span className={TONE_CLASS[said.tone]}>{said.text}</span>;
      },
    },
    createAgeColumn<RouteInfo>(),
  ];

  const quickActions = (
    setDeleteTarget: (item: RouteInfo) => void
  ): QuickAction<RouteInfo>[] => [
    {
      icon: Eye,
      label: "View Details",
      onClick: (item) =>
        navigate(getResourceDetailUrl(item.kind, item.name, item.namespace)),
    },
    {
      icon: Trash2,
      label: "Delete",
      variant: "destructive",
      onClick: (item) => setDeleteTarget(item),
    },
  ];

  return (
    <ResourceList<RouteInfo>
      title={(count) => `Routes (${count})`}
      description="Every Gateway API route kind in scope, in one list."
      data={routes}
      isLoading={isLoading}
      error={error}
      dataUpdatedAt={dataUpdatedAt}
      live={active.length > 0 && !watchFailed}
      resyncing={active.some((entry) => entry.resyncing)}
      columns={columns}
      emptyStateLabel="routes"
      emptyMessage={
        detection && !detection.installed
          ? "This cluster does not serve the Gateway API route kinds."
          : "No routes in the current scope."
      }
      searchKey="name"
      getRowHref={(row) =>
        getResourceDetailUrl(row.kind, row.name, row.namespace)
      }
      getRowId={(row) => `${row.kind}/${row.namespace}/${row.name}`}
      quickActions={quickActions}
      deleteConfig={{
        mutationFn: (item) =>
          commands.deleteGatewayRoute(item.kind, item.name, item.namespace),
        invalidateQueryKeys: ROUTE_KINDS.map((kind) => [
          "gateway-routes",
          kind,
          currentNamespace ?? "all",
        ]),
        resourceType: "route",
      }}
    />
  );
}
