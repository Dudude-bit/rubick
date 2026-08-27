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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { gatewayTopology } from "./gateway-topology";
import {
  GATEWAY_ROUTE_KINDS as ROUTE_KINDS,
  useGatewayRoutes,
} from "@/hooks/useGatewayRoutes";
import { useLinkGesture } from "@/hooks/useLinkGesture";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { ROUTING_STALE, RoutingMap, useBackingLists } from "@/integrations";
import { commands } from "@/lib/commands";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { KIND_TONE } from "@/lib/route-kind-tone";
import { routesBoard, type RouteRow } from "@/lib/route-rows";
import { useT, type T } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { useClusterStore } from "@/stores/clusterStore";
import { cn } from "@/lib/utils";
import { verbatim } from "@/lib/error-utils";
import type { RouteInfo } from "@/generated/types";

// Radix refuses an empty string as an item value, so the "no filter"
// choice needs a name of its own rather than the empty kind it means.
const ALL_KINDS = "__all__";

/** The step a break lands on, in the reader's language. */
function stepWord(at: string, t: T): string {
  switch (at) {
    case "class":
      return t("columns", "stepClass");
    case "gateway":
      return t("columns", "stepGateway");
    case "listener":
      return t("columns", "stepListener");
    case "namespace":
      return t("columns", "stepNamespace");
    case "refs":
      return t("columns", "stepRefs");
    case "backend":
      return t("columns", "stepBackend");
    case "endpoints":
      return t("columns", "stepEndpoints");
    case "reachable":
      return t("columns", "stepReachable");
    case "route":
      return t("columns", "stepRoute");
    default:
      return at;
  }
}

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

function Row({
  row,
  muted,
  mesh = false,
}: {
  row: RouteRow;
  muted: boolean;
  /** Mesh rows are built `serving: true` but have no gateway to serve
   *  through, so their dot stays quiet. Passed rather than sniffed out of
   *  `row.tail`, which is a translated sentence — the old check survived
   *  only because both catalogues happen to keep the word "GAMMA". */
  mesh?: boolean;
}) {
  const t = useT();
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
          muted || mesh ? "text-fg-fnt" : row.serving ? "text-ok" : "text-err"
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
            label={t("action", "copyPair", { pair: row.servesCopy })}
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
        {row.stop
          ? parts(t("empty", "gwStopsAtPhrase", { short: row.stop.short }), {
              at: (
                <span className="font-semibold">
                  {stepWord(row.stop.at, t)}
                </span>
              ),
            })
          : (row.tail ?? "")}
        {row.stale && (
          <span className="text-warn">
            {" · "}
            {t("empty", "gwStaleChipRow", {
              observed: row.stale.observed,
              current: row.stale.current,
            })}
          </span>
        )}
        {row.contested && (
          <span className="text-warn">
            {" · "}
            {t("empty", "gwContestedBy", { by: row.contested.by })}
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
                aria-label={t("empty", "kindDoesNotExist", {
                  kind: row.viaGhost.kind,
                  name: row.viaGhost.name,
                })}
                className="relative top-px flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border border-dashed border-hair text-[9px] leading-none"
              >
                ?
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[42ch]">
              {t("empty", "gwGhostTooltip", {
                kind: row.viaGhost.kind,
                name: row.viaGhost.name,
                namespace: row.viaGhost.namespace ?? "",
              })}
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
  const t = useT();
  const isConnected = useClusterStore((s) => s.isConnected);
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const {
    detection,
    detectionLoading,
    detectionError,
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
      routesBoard(
        filtered,
        {
          gateways: gateways.data ?? [],
          classes: classes.data ?? [],
          topologyKnown:
            gateways.data !== undefined &&
            (classes.data !== undefined || !served.has("GatewayClass")),
          backing: {
            services: backing.data?.services ?? [],
            published: backing.data?.published ?? [],
            backingKnown: backing.data !== undefined,
          },
        },
        t
      ),
    [filtered, gateways.data, classes.data, backing.data, served, t]
  );

  // The map's outer columns: pods and deployments, read only while the
  // map is open — the list alone never pays for them.
  const pods = useLiveQuery({
    queryKey: ["map-pods"],
    queryFn: () =>
      commands.listPods({
        namespace: null,
        labelSelector: null,
        fieldSelector: null,
        limit: null,
        statusFilter: null,
        selector: null,
        nodeName: null,
      }),
    staleTime: ROUTING_STALE,
    refresh: "overview",
    enabled: showMap,
  });
  const deployments = useLiveQuery({
    queryKey: ["map-deployments"],
    queryFn: () =>
      commands.listDeployments({
        namespace: null,
        labelSelector: null,
        fieldSelector: null,
        limit: null,
      }),
    staleTime: ROUTING_STALE,
    refresh: "overview",
    enabled: showMap,
  });

  const topology = useMemo(
    () =>
      gatewayTopology(
        gateways.data,
        filtered,
        backing.data ? { ...backing.data, backingKnown: true } : undefined,
        t,
        pods.data && deployments.data
          ? { pods: pods.data, deployments: deployments.data }
          : undefined
      ),
    [gateways.data, filtered, backing.data, t, pods.data, deployments.data]
  );

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={t("nav", "routes")} />;
  }

  if (detection && !detection.installed) {
    return (
      <div className="p-6">
        <h1 className="text-sm font-semibold text-fg">{t("nav", "routes")}</h1>
        <p className="mt-2 max-w-[64ch] text-xs text-fg-fnt">
          {t("empty", "gwNoCrdsPage")}
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
        title={t("nav", "routes")}
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
                  {t("count", "gwNotServingCount", {
                    n: board.notServing.length,
                  })}
                </button>
              </>
            )}
            {quietCluster && total > 0 && ` · ${t("empty", "gwAllServing")}`}
          </span>
        }
        dataUpdatedAt={dataUpdatedAt}
        live={live && !resyncing}
        actions={
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("action", "gwFilterPlaceholder")}
              aria-label={t("action", "filterRoutes")}
              className="h-7 w-52 rounded-md border border-hair bg-transparent px-2.5 text-xs text-fg placeholder:text-fg-fnt focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
            />
            <Select
              value={kind === "" ? ALL_KINDS : kind}
              onValueChange={(value) =>
                setKind(value === ALL_KINDS ? "" : value)
              }
            >
              <SelectTrigger
                aria-label={t("action", "filterByKind")}
                className="h-7 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_KINDS}>
                  {t("action", "allKinds")}
                </SelectItem>
                {ROUTE_KINDS.filter((k) => served.has(k)).map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={showMap}
              onClick={() => setShowMap((on) => !on)}
            >
              <MapGlyph className="mr-1.5 h-3.5 w-3.5" />
              {showMap ? t("action", "hideMap") : t("action", "map")}
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
            {parts(t("empty", "gwPulseLine", { say: entry.say }), {
              name: <span className="font-mono text-fg">{entry.gateway}</span>,
            })}
          </span>
          <Link
            to="/network/gateways"
            className="ml-auto whitespace-nowrap text-info hover:underline"
          >
            {t("action", "openGateways")}
          </Link>
        </div>
      ))}

      {showMap && (
        <div className="mt-3 flex flex-col gap-1">
          {topology.columns[topology.spine ?? 1].nodes.length === 0 ? (
            <p className="max-w-[64ch] text-xs text-fg-mut">
              {t("empty", "gwNothingToDraw")}
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
              {t("empty", "gwCouldNotReadRoutes")}
            </p>
            <p className="mt-1.5 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
              {verbatim(error.message)}
            </p>
          </div>
        ) : isLoading && routes.length === 0 ? (
          <p className="py-8 text-xs text-fg-fnt">
            {t("empty", "readingRoutes")}
          </p>
        ) : detectionError ? (
          // Every kind query is gated on the CRD scan, so a scan that failed
          // leaves this page with an empty list and nothing to say about it.
          // "No routes in the current scope" would be a claim about a cluster
          // nobody managed to ask.
          <div className="max-w-[68ch] py-8">
            <p className="text-xs text-err">
              {t("empty", "gwCouldNotCheckInstall")}
            </p>
            <p className="mt-1.5 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
              {verbatim(detectionError.message)}
            </p>
          </div>
        ) : detectionLoading ? (
          <p className="py-8 text-xs text-fg-fnt">
            {t("empty", "gwCheckingInstall")}
          </p>
        ) : total + board.mesh.length === 0 ? (
          <p className="py-8 text-xs text-fg-fnt">
            {routes.length === 0
              ? t("empty", "gwNoRoutesInScope")
              : t("empty", "nothingMatchesFilter")}
          </p>
        ) : !board.verdictsKnown ? (
          <>
            <p className="px-0.5 pb-1.5 pt-4 text-[11px] text-fg-fnt">
              {/* Still reading and could not read look the same from here —
                  both leave `data` undefined — but they are not the same
                  thing to wait for. */}
              {gateways.error || classes.error
                ? t("empty", "gwCouldNotReadVerdicts")
                : t("empty", "gwReadingVerdicts")}
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
                  label={t("empty", "gwNotServing")}
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
                  <GroupCap
                    label={t("empty", "gwServing")}
                    count={board.serving.length}
                  />
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
                <GroupCap
                  label={t("empty", "gwMeshGroup")}
                  count={board.mesh.length}
                />
                <div className="border-t border-hair">
                  {board.mesh.map((row) => (
                    <Row
                      key={`${row.kind}/${row.namespace}/${row.name}`}
                      row={row}
                      muted={false}
                      mesh
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
