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

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, Map as MapGlyph, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { ResourceList } from "./ResourceList";
import { ResourceType } from "@/lib/resource-registry";
import {
  createAgeColumn,
  createNameColumn,
  createNamespaceColumn,
} from "./columns";
import { gatewayTopology } from "./gateway-topology";
import {
  GATEWAY_ROUTE_KINDS as ROUTE_KINDS,
  useGatewayRoutes,
} from "@/hooks/useGatewayRoutes";
import { Button } from "@/components/ui/button";
import { RoutingMap, useBackingLists } from "@/integrations";
import { commands } from "@/lib/commands";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { useClusterStore } from "@/stores/clusterStore";
import { cn } from "@/lib/utils";
import type { QuickAction } from "@/components/ui/quick-actions";
import type { ColumnDef } from "@tanstack/react-table";
import type { RouteInfo } from "@/generated/types";

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

/** One filter chip. Active is the selection surface, not a new colour. */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "relative rounded-full border border-hair px-2.5 py-0.5 text-[11px]",
        // The visual stays chip-sized; the hit area does not.
        "after:absolute after:-inset-2 after:content-['']",
        active ? "bg-sel text-fg" : "text-fg-mut hover:bg-hover"
      )}
    >
      {children}
    </button>
  );
}

type Verdict = "all" | "accepted" | "refused" | "unanswered";

const VERDICTS: Array<{ id: Verdict; label: string }> = [
  { id: "all", label: "Any verdict" },
  { id: "accepted", label: "Accepted" },
  { id: "refused", label: "Refused" },
  { id: "unanswered", label: "No controller answered" },
];

function matchesVerdict(route: RouteInfo, verdict: Verdict): boolean {
  if (verdict === "all") return true;
  const tone = acceptance(route).tone;
  if (verdict === "accepted") return tone === "ok";
  if (verdict === "refused") return tone === "err";
  return tone === "mute";
}

export function GatewayRoutesList() {
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const navigate = useNavigate();
  const {
    detection,
    served,
    routes,
    isLoading,
    error,
    dataUpdatedAt,
    live,
    resyncing,
  } = useGatewayRoutes(currentNamespace);

  // The filters narrow the table and the map together: a map of everything
  // beside a table of one kind would be two answers to one question.
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict>("all");
  const filtered = useMemo(
    () =>
      routes.filter(
        (route) =>
          (kindFilter === null || route.kind === kindFilter) &&
          matchesVerdict(route, verdict)
      ),
    [routes, kindFilter, verdict]
  );

  // The map's own ingredients: every Gateway (unscoped — routes attach
  // across namespaces) and what each backend Service publishes.
  const [showMap, setShowMap] = useState(false);
  const gateways = useQuery({
    queryKey: ["gateway-map-gateways"],
    queryFn: () => commands.listGateways(null),
    staleTime: 60_000,
    enabled: showMap && served.has("Gateway"),
  });
  const backing = useBackingLists();
  const topology = useMemo(
    () =>
      gatewayTopology(
        gateways.data ?? [],
        filtered,
        backing.data ? { ...backing.data, backingKnown: true } : undefined
      ),
    [gateways.data, filtered, backing.data]
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
      data={filtered}
      isLoading={isLoading}
      error={error}
      dataUpdatedAt={dataUpdatedAt}
      live={live}
      resyncing={resyncing}
      columns={columns}
      emptyStateLabel="routes"
      emptyMessage={
        detection && !detection.installed
          ? "This cluster does not serve the Gateway API route kinds."
          : "No routes in the current scope."
      }
      searchKey="name"
      headerActions={
        <Button
          variant="outline"
          size="sm"
          aria-pressed={showMap}
          onClick={() => setShowMap((on) => !on)}
        >
          <MapGlyph className="mr-1.5 h-3.5 w-3.5" />
          {showMap ? "Hide map" : "Map"}
        </Button>
      }
      headerContent={
        <div className="flex flex-col gap-2 px-1 pb-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex flex-wrap gap-2">
              <Chip
                active={kindFilter === null}
                onClick={() => setKindFilter(null)}
              >
                All kinds
              </Chip>
              {ROUTE_KINDS.filter((kind) => served.has(kind)).map((kind) => (
                <Chip
                  key={kind}
                  active={kindFilter === kind}
                  onClick={() =>
                    setKindFilter((current) => (current === kind ? null : kind))
                  }
                >
                  {kind}
                </Chip>
              ))}
            </div>
            <span aria-hidden className="h-4 w-px bg-hair" />
            <div className="flex flex-wrap gap-2">
              {VERDICTS.map((entry) => (
                <Chip
                  key={entry.id}
                  active={verdict === entry.id}
                  onClick={() => setVerdict(entry.id)}
                >
                  {entry.label}
                </Chip>
              ))}
            </div>
          </div>
          {showMap &&
            (topology.columns[1].nodes.length === 0 ? (
              <p className="max-w-[64ch] text-xs text-fg-mut">
                Nothing to draw for this filter — no route matches it.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                <RoutingMap data={topology} />
                <p className="text-[11px] text-fg-fnt">
                  {gateways.isError
                    ? "The Gateways could not be read, so entry points named by a route draw as missing — which here means unread, not absent."
                    : "Rest on a node to light up everything one edge away. Every line is one object naming another; the filters above narrow this map and the list together."}
                </p>
              </div>
            ))}
        </div>
      }
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
