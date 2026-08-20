/**
 * The routes list is the trace's index: one line per route, the verdict
 * first, said in exactly the words the route's detail page will expand.
 * Broken float to the top, upstream-most break first; a healthy cluster
 * gets a flat quiet inventory with no red group and no group labels at
 * all — the chrome exists only when something is wrong.
 *
 * The verdicts come from `routesBoard` — the same `routeTraces` the detail
 * page draws, reduced to a phrase — so the list can never again say
 * "accepted" about a route that is dead two steps later.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Map as MapGlyph } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { CopyableValue } from "@/components/ui/copyable-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { ResourceListHeader } from "@/components/resources/ResourceListHeader";
import { RealtimeAge } from "@/components/ui/realtime";
import { Button } from "@/components/ui/button";
import { gatewayTopology } from "./gateway-topology";
import {
  GATEWAY_ROUTE_KINDS as ROUTE_KINDS,
  useGatewayRoutes,
} from "@/hooks/useGatewayRoutes";
import { useLinkGesture } from "@/hooks/useLinkGesture";
import { RoutingMap, useBackingLists } from "@/integrations";
import { commands } from "@/lib/commands";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { routesBoard, type RouteRow } from "@/lib/route-rows";
import { useClusterStore } from "@/stores/clusterStore";
import { cn } from "@/lib/utils";
import { verbatim } from "@/lib/error-utils";
import type { RouteInfo } from "@/generated/types";

/** Gateways change with a deploy, not by the second — same as the map. */
const ROUTING_STALE = 60_000;

/**
 * Kind hues sit away from the state colors (ok 152, warn 44, err 358,
 * info 212) and stay desaturated: the verdict dot outranks the kind, and
 * the label text still carries the meaning without the hue.
 */
const KIND_TONE: Record<string, string> = {
  HTTPRoute: "border-[hsl(190_45%_58%/0.35)] text-[hsl(190_45%_58%)]",
  GRPCRoute: "border-[hsl(265_50%_70%/0.35)] text-[hsl(265_50%_70%)]",
  TLSRoute: "border-[hsl(315_40%_64%/0.35)] text-[hsl(315_40%_64%)]",
  TCPRoute: "border-[hsl(25_55%_60%/0.35)] text-[hsl(25_55%_60%)]",
  UDPRoute: "border-[hsl(85_35%_55%/0.35)] text-[hsl(85_35%_55%)]",
};

/** One template for every row, so the columns align across rows. */
const ROW_GRID =
  "grid grid-cols-[14px_minmax(200px,255px)_1fr_84px_minmax(140px,170px)_105px_38px] items-baseline gap-x-3";

function matchesQuery(route: RouteInfo, query: string): boolean {
  if (query === "") return true;
  const q = query.toLowerCase();
  return (
    route.name.toLowerCase().includes(q) ||
    route.kind.toLowerCase().includes(q) ||
    route.hostnames.some((host) => host.toLowerCase().includes(q)) ||
    route.parentRefs.some((parent) => parent.name.toLowerCase().includes(q))
  );
}

function Row({ row, muted }: { row: RouteRow; muted: boolean }) {
  const navigate = useNavigate();
  const linkGesture = useLinkGesture();
  const href = getResourceDetailUrl(row.kind, row.name, row.namespace);

  // Not an anchor, on purpose: the via cell holds a real ResourceRef, and
  // an anchor inside an anchor is where browsers split the row apart. The
  // same rule the data table's rows follow — inner links and buttons are
  // their own targets, everything else activates the row.
  const act = (event: React.MouseEvent | React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("a") || target.closest("button")) return;
    linkGesture(event, href, () => navigate(href));
  };

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`${row.kind} ${row.name}`}
      onClick={act}
      onAuxClick={act}
      onKeyDown={(event) => {
        if (event.key === "Enter") act(event);
      }}
      className={cn(
        ROW_GRID,
        "cursor-pointer border-b border-hair px-1.5 py-1.5 hover:bg-hover focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-info"
      )}
    >
      <span
        className={cn(
          "justify-self-center text-[9px] leading-none",
          muted || row.tail?.includes("GAMMA")
            ? "text-fg-fnt"
            : row.serving
              ? "text-ok"
              : "text-err"
        )}
      >
        ●
      </span>
      <span className="flex min-w-0 items-baseline gap-1 font-mono text-xs text-fg">
        {/* What lands on the clipboard may be more than the label: a
            hostless route copies the dialable address:port while showing
            the listener's :port. No honest value — plain text. */}
        {row.servesCopy ? (
          <CopyableValue
            value={row.servesCopy}
            label={`Copy ${row.servesCopy}`}
            className="min-w-0 text-xs"
          >
            {row.serves}
          </CopyableValue>
        ) : (
          <span className="truncate">{row.serves}</span>
        )}
        {row.more > 0 && (
          <span className="flex-none font-sans text-fg-fnt">+{row.more}</span>
        )}
      </span>
      <span
        className={cn(
          "truncate text-xs",
          row.stop && !muted ? "text-err" : "text-fg-fnt"
        )}
      >
        {row.stop ? (
          <>
            stops at <span className="font-semibold">{row.stop.at}</span> —{" "}
            {row.stop.short}
          </>
        ) : (
          (row.tail ?? "")
        )}
        {row.stale && (
          <span className="text-warn">
            {" "}
            · verdict about gen {row.stale.observed}, you are on{" "}
            {row.stale.current}
          </span>
        )}
        {row.contested && (
          <span className="text-warn">
            {" "}
            · host also claimed by {row.contested.by} — the older route wins
          </span>
        )}
      </span>
      <span
        className={cn(
          "justify-self-start whitespace-nowrap rounded border px-1 text-[10.5px]",
          KIND_TONE[row.kind] ?? "border-hair text-fg-fnt"
        )}
      >
        {row.kind}
      </span>
      <span className="truncate font-mono text-xs text-fg-mut">{row.name}</span>
      <span className="truncate text-xs text-fg-fnt">
        {row.viaRef && row.via.startsWith(row.viaRef.name) ? (
          <>
            <ResourceRef
              kind={row.viaRef.kind}
              name={row.viaRef.name}
              namespace={row.viaRef.namespace}
              showKind={false}
            />
            {row.via.slice(row.viaRef.name.length)}
          </>
        ) : row.viaGhost ? (
          <Tooltip>
            <TooltipTrigger className="inline-flex items-baseline gap-1.5">
              {row.via}
              <span
                aria-label={`${row.viaGhost.kind} ${row.viaGhost.name} does not exist`}
                className="relative top-px flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border border-dashed border-hair text-[9px] leading-none"
              >
                ?
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[42ch]">
              {row.viaGhost.kind} {row.viaGhost.name} does not exist in{" "}
              {row.viaGhost.namespace} — this route names an object that is not
              there, so nothing can accept it. Usually a typo, or it was deleted
              after the route was written.
            </TooltipContent>
          </Tooltip>
        ) : (
          row.via
        )}
      </span>
      <span className="text-right text-[11px] tabular-nums text-fg-fnt">
        <RealtimeAge timestamp={row.createdAt} />
      </span>
    </div>
  );
}

function GroupCap({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone?: "err";
}) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-1.5 px-0.5 pb-1.5 pt-4 text-[10.5px] font-semibold uppercase tracking-wide",
        tone === "err" ? "text-err" : "text-fg-fnt"
      )}
    >
      {label} <span className="font-normal text-fg-mut">{count}</span>
    </div>
  );
}

export function GatewayRoutesList() {
  const isConnected = useClusterStore((s) => s.isConnected);
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
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

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [brokenOnly, setBrokenOnly] = useState(false);
  const [showMap, setShowMap] = useState(false);

  // Unscoped on purpose, twice over: routes attach to Gateways in other
  // namespaces, and the class claim is cluster-scoped. Same keys as the
  // trace on the detail page, so list → detail reuses the cache.
  const gateways = useQuery({
    queryKey: ["gateway-map-gateways"],
    queryFn: () => commands.listGateways(null),
    staleTime: ROUTING_STALE,
    enabled: served.has("Gateway"),
  });
  const classes = useQuery({
    queryKey: ["gateway-classes"],
    queryFn: commands.listGatewayClasses,
    staleTime: ROUTING_STALE,
    enabled: served.has("GatewayClass"),
  });
  const backing = useBackingLists();

  const filtered = useMemo(
    () =>
      routes.filter(
        (route) =>
          (kind === "" || route.kind === kind) && matchesQuery(route, query)
      ),
    [routes, kind, query]
  );

  const board = useMemo(
    () =>
      routesBoard(filtered, {
        gateways: gateways.data ?? [],
        classes: classes.data ?? [],
        topologyKnown: gateways.data !== undefined,
        backing: {
          services: backing.data?.services ?? [],
          published: backing.data?.published ?? [],
          backingKnown: backing.data !== undefined,
        },
      }),
    [filtered, gateways.data, classes.data, backing.data]
  );

  const topology = useMemo(
    () =>
      gatewayTopology(
        gateways.data ?? [],
        filtered,
        backing.data ? { ...backing.data, backingKnown: true } : undefined
      ),
    [gateways.data, filtered, backing.data]
  );

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel="routes" />;
  }

  if (detection && !detection.installed) {
    return (
      <div className="p-6">
        <h1 className="text-sm font-semibold text-fg">Routes</h1>
        <p className="mt-2 max-w-[64ch] text-xs text-fg-fnt">
          This cluster does not serve the Gateway API route kinds. Install the
          CRDs (the standard channel is enough) and this page fills in on its
          own.
        </p>
      </div>
    );
  }

  const total = board.notServing.length + board.serving.length;
  const quietCluster = board.verdictsKnown && board.notServing.length === 0;
  const shown = brokenOnly ? [] : board.serving;

  return (
    <div className="flex h-full flex-col p-6">
      <ResourceListHeader
        title="Routes"
        count={
          <span className="tabular-nums">
            {total + board.mesh.length}
            {board.verdictsKnown && board.notServing.length > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  aria-pressed={brokenOnly}
                  onClick={() => setBrokenOnly((on) => !on)}
                  className={cn(
                    "text-err hover:underline",
                    brokenOnly && "underline"
                  )}
                >
                  {board.notServing.length} not serving
                </button>
              </>
            )}
            {quietCluster && total > 0 && " · all serving"}
          </span>
        }
        dataUpdatedAt={dataUpdatedAt}
        live={live && !resyncing}
        actions={
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="name, host, gateway…"
              aria-label="Filter routes"
              className="h-7 w-52 rounded-md border border-hair bg-transparent px-2.5 text-xs text-fg placeholder:text-fg-fnt focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
            />
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              aria-label="Filter by kind"
              className="h-7 rounded-md border border-hair bg-canvas px-2 text-xs text-fg-mid focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
            >
              <option value="">All kinds</option>
              {ROUTE_KINDS.filter((k) => served.has(k)).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={showMap}
              onClick={() => setShowMap((on) => !on)}
            >
              <MapGlyph className="mr-1.5 h-3.5 w-3.5" />
              {showMap ? "Hide map" : "Map"}
            </Button>
          </div>
        }
      />

      {board.pulse.map((entry) => (
        <div
          key={`${entry.namespace}/${entry.gateway}`}
          className="mt-3 flex items-baseline gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-1.5 text-xs"
        >
          <span className="text-[9px] text-warn">●</span>
          <span className="text-fg-mid">
            Gateway <span className="font-mono text-fg">{entry.gateway}</span>{" "}
            {entry.say}.
          </span>
          <Link
            to="/network/gateways"
            className="ml-auto whitespace-nowrap text-info hover:underline"
          >
            Open Gateways →
          </Link>
        </div>
      ))}

      {showMap && (
        <div className="mt-3 flex flex-col gap-1">
          {topology.columns[1].nodes.length === 0 ? (
            <p className="max-w-[64ch] text-xs text-fg-mut">
              Nothing to draw for this filter — no route matches it.
            </p>
          ) : (
            <RoutingMap data={topology} />
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && routes.length === 0 ? (
          <div className="max-w-[68ch] py-8">
            <p className="text-xs text-err">
              Could not read routes in this scope.
            </p>
            <p className="mt-1.5 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
              {verbatim(error.message)}
            </p>
          </div>
        ) : isLoading && routes.length === 0 ? (
          <p className="py-8 text-xs text-fg-fnt">Reading routes…</p>
        ) : total + board.mesh.length === 0 ? (
          <p className="py-8 text-xs text-fg-fnt">
            {routes.length === 0
              ? "No routes in the current scope."
              : "Nothing matches the filter."}
          </p>
        ) : !board.verdictsKnown ? (
          <>
            <p className="px-0.5 pb-1.5 pt-4 text-[11px] text-fg-fnt">
              Reading verdicts — gateways, classes and endpoints are still on
              their way…
            </p>
            <div className="border-t border-hair">
              {[...board.notServing, ...board.serving, ...board.mesh].map(
                (row) => (
                  <Row
                    key={`${row.kind}/${row.namespace}/${row.name}`}
                    row={row}
                    muted
                  />
                )
              )}
            </div>
          </>
        ) : (
          <>
            {board.notServing.length > 0 && (
              <>
                <GroupCap
                  label="Not serving"
                  count={board.notServing.length}
                  tone="err"
                />
                <div className="border-t border-hair">
                  {board.notServing.map((row) => (
                    <Row
                      key={`${row.kind}/${row.namespace}/${row.name}`}
                      row={row}
                      muted={false}
                    />
                  ))}
                </div>
              </>
            )}
            {shown.length > 0 && (
              <>
                {/* A healthy cluster is a flat inventory: no labels, no red
                    group — the chrome only exists alongside trouble. */}
                {!quietCluster && (
                  <GroupCap label="Serving" count={board.serving.length} />
                )}
                <div
                  className={cn("border-t border-hair", quietCluster && "mt-4")}
                >
                  {shown.map((row) => (
                    <Row
                      key={`${row.kind}/${row.namespace}/${row.name}`}
                      row={row}
                      muted={false}
                    />
                  ))}
                </div>
              </>
            )}
            {!brokenOnly && board.mesh.length > 0 && (
              <>
                <GroupCap label="Mesh" count={board.mesh.length} />
                <div className="border-t border-hair">
                  {board.mesh.map((row) => (
                    <Row
                      key={`${row.kind}/${row.namespace}/${row.name}`}
                      row={row}
                      muted={false}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
