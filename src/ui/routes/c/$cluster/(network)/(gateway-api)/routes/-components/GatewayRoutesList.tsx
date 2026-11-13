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
import { Link, useNavigate } from "@tanstack/react-router";

import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { CopyableValue } from "@/components/ui/copyable-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ResourceRef } from "@/components/object/ResourceRef";
import { ResourceListHeader } from "../../../../-list/ResourceListHeader";
import { UnreadNamespaces } from "../../../../-list/UnreadNamespaces";
import { NamedRowsBanner } from "../../../../-list/NamedRows";
import { useNamedRows } from "../../../../-list/useNamedRows";
import { Unknown } from "@/components/ui/unknown";
import { inScope, noneWhereAnswered } from "@/lib/namespace-scope";
import { RealtimeAge } from "@/components/ui/realtime";
import { controlAt } from "@/lib/row-control";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/section";
import { EmptyState, Eyebrow, Reading } from "@/components/ui/states";
import { TableSkeleton } from "@/components/ui/skeleton";
import { StaleRows } from "@/components/ui/stale-rows";
import { UnreadList } from "../../../../-list/UnreadList";
import { useRefusedAt } from "@/lib/refusals";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { gatewayTopology } from "./gateway-topology";
import { useGatewayRoutes } from "../../../../-object/useGatewayRoutes";
import { useDoorAsk } from "@/hooks/useDoorAsk";
import { useLinkGesture } from "@/hooks/useLinkGesture";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useWatchedList } from "@/hooks/useWatchedList";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import {
  backingFrom,
  ROUTING_STALE,
  RoutingMap,
  useBackingLists,
} from "@/integrations";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { listPodRows, type PodRow } from "@/lib/pod-rows";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { hrefOf, listLink, objectLink, rowName } from "@/lib/links";
import { KIND_TONE } from "@/lib/route-kind-tone";
import {
  allServing,
  GATEWAY_ROUTE_KINDS as ROUTE_KINDS,
  pulseFor,
  routesBoard,
  STEP_WORD,
  type RouteRow,
} from "@/lib/route-rows";
import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { useClusterStore } from "@/stores/clusterStore";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { cn } from "@/lib/utils";
import { isRefusal } from "@/lib/error-utils";
import type { RouteInfo } from "@/generated/types";

const EVERY_POD = queryKeys.podRows(null);
const POD_DETAIL = queryKeys.rowDetail(ResourceType.Pod);
const subscribeEveryPod = () => commands.subscribePodRowWatch(null);

// Radix refuses an empty string as an item value, so the "no filter"
// choice needs a name of its own rather than the empty kind it means.
const ALL_KINDS = "__all__";

/** The step a break lands on, in the reader's language. */
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
  const link = objectLink({
    kind: row.kind,
    name: row.name,
    namespace: row.namespace,
  })!;
  const href = hrefOf(link);

  // Not an anchor, on purpose: the via cell holds a real ResourceRef, and
  // an anchor inside an anchor is where browsers split the row apart. The
  // same rule the data table's rows follow — inner links and buttons are
  // their own targets, everything else activates the row.
  const act = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (controlAt(event.target as HTMLElement)) return;
    linkGesture(event, href, () => navigate(link));
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
          "justify-self-center text-micro leading-none",
          muted || mesh || (row.serving && !row.servingKnown)
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
        title={
          row.stop
            ? t("empty", "gwStopsAtPhrase", {
                short: row.stop.short,
                at: t("columns", STEP_WORD[row.stop.at]),
              })
            : (row.tail ?? undefined)
        }
      >
        {row.stop
          ? parts(t("empty", "gwStopsAtPhrase", { short: row.stop.short }), {
              at: (
                <span className="font-semibold">
                  {t("columns", STEP_WORD[row.stop.at])}
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
          "justify-self-start whitespace-nowrap rounded border px-1 text-caption",
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
                className="relative top-px flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border border-dashed border-hair text-micro leading-none"
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
      <span className="text-right text-caption tabular-nums text-fg-fnt">
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
    <Eyebrow
      as="h3"
      className={cn(
        "flex items-baseline gap-1.5 px-0.5 pb-1.5 pt-4",
        tone === "err" && "text-err"
      )}
    >
      {label} <span className="font-normal text-fg-mut">{count}</span>
    </Eyebrow>
  );
}

function UnsettledRows({
  rows,
  why,
  reading,
}: {
  rows: RouteRow[];
  why: string;
  reading: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      {reading ? (
        <Reading className="px-0.5 pb-1.5 pt-4">{why}</Reading>
      ) : (
        <p className="px-0.5 pb-1.5 pt-4 text-caption text-fg-fnt">{why}</p>
      )}
      <div className="border-t border-hair">
        {rows.map((row) => (
          <Row
            key={`${row.kind}/${row.namespace}/${row.name}`}
            row={row}
            muted
          />
        ))}
      </div>
    </>
  );
}

export function GatewayRoutesList() {
  const t = useT();
  const isConnected = useClusterStore((s) => s.isConnected);
  const scope = useNamespaceScope();
  const {
    detection,
    detectionLoading,
    detectionError,
    served,
    routes,
    unread,
    refusedKinds,
    isLoading,
    error,
    dataUpdatedAt,
    live,
    resyncing,
    failedRefresh,
    refetch,
    refetchScan,
  } = useGatewayRoutes(scope.scope);
  const refused = !!error && isRefusal(error);
  const refusedAt = useRefusedAt(refused ? error : null);

  const [query, setQuery] = useState("");
  // `listOf` is how a link to one route kind's list arrives: the same ask as `kind`.
  const { kind: kindParam, listOf } = useAppSearch();
  const setSearch = useSetSearch();
  const asked = kindParam ?? listOf;
  const kind = ROUTE_KINDS.find((k) => toPlural(k) === asked) ?? "";
  const named = useNamedRows();
  const [brokenOnly, setBrokenOnly] = useState(false);
  const [showMap, setShowMap] = useState(false);

  // Unscoped on purpose, twice over: routes attach to Gateways in other
  // namespaces, and the class claim is cluster-scoped. Same keys as the
  // trace on the detail page, so list → detail reuses the cache.
  const gateways = useQuery({
    queryKey: queryKeys.gateways(),
    queryFn: () => commands.listGateways(null),
    staleTime: ROUTING_STALE,
    enabled: served.has("Gateway"),
  });
  const classes = useQuery({
    queryKey: queryKeys.gatewayClasses(),
    queryFn: commands.listGatewayClasses,
    staleTime: ROUTING_STALE,
    enabled: served.has("GatewayClass"),
  });
  const backing = useBackingLists();
  const door = useDoorAsk();

  const narrowed = useMemo(
    () =>
      routes.filter(
        (route) =>
          (kind === "" || route.kind === kind) &&
          (!named || named.has(rowName(route)))
      ),
    [routes, kind, named]
  );
  const filtered = useMemo(
    () => narrowed.filter((route) => matchesQuery(route, query)),
    [narrowed, query]
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
          backing: backingFrom(backing.data, backing.error),
          door,
        },
        t
      ),
    [
      filtered,
      gateways.data,
      classes.data,
      backing.data,
      backing.error,
      served,
      door,
      t,
    ]
  );

  // A Gateway another team broke is not news on a window none of its routes cross.
  const pulse = useMemo(
    () =>
      pulseFor(board.pulse, filtered, gateways.data ?? [], (namespace) =>
        inScope(scope.scope, namespace)
      ),
    [board.pulse, filtered, gateways.data, scope.scope]
  );

  // The map's last column, read only while the map is open. The Pods list's
  // own entry and its way of reading: rows in chunks, then kept by the watch.
  // Every pod whole, in one answer, every ten seconds was 78 MiB a read on
  // 10 000 pods.
  const watchedPods = useWatchedList<PodRow>({
    enabled: showMap,
    subscribe: subscribeEveryPod,
    queryKey: EVERY_POD,
    detail: POD_DETAIL,
  });
  const pods = useLiveQuery({
    queryKey: EVERY_POD,
    queryFn: ({ signal }) => listPodRows(null, signal),
    staleTime: ROUTING_STALE,
    refresh: watchedPods.live ? false : "overview",
    enabled: showMap,
  });

  const topology = useMemo(
    () =>
      gatewayTopology(
        gateways.data,
        filtered,
        backing.data ? backingFrom(backing.data, null) : undefined,
        t,
        pods.data && { pods: pods.data.rows },
        { classes: classes.data ?? [], ask: door }
      ),
    [gateways.data, filtered, backing.data, t, pods.data, classes.data, door]
  );

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={t("nav", "routes")} />;
  }

  if (detection && !detection.installed) {
    return (
      <div className="flex flex-col gap-2">
        <SectionHeader title={t("nav", "routes")} />
        <EmptyState>{t("empty", "gwNoCrdsPage")}</EmptyState>
      </div>
    );
  }

  const total =
    board.notServing.length + board.unknown.length + board.serving.length;
  const quietCluster = allServing(board);
  const shown = brokenOnly ? [] : board.serving;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ResourceListHeader
        title={t("nav", "routes")}
        count={
          // No count beside a refusal or a detection failure — the body shows
          // "could not read" there, and a "0" in the header would contradict
          // it. These are the same states the body special-cases below. Nor
          // beside an unread namespace: the rows are not the scope's total.
          ((error || isLoading) && routes.length === 0) ||
          detectionLoading ||
          detectionError ||
          unread.length > 0 ||
          refusedKinds.length > 0 ? undefined : (
            <span className="tabular-nums">
              {total + board.mesh.length}
              {board.notServing.length > 0 && (
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
          )
        }
        dataUpdatedAt={dataUpdatedAt}
        live={live && !resyncing && !refused}
        stale={failedRefresh !== null}
        refusedAt={refused ? refusedAt : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("action", "gwFilterPlaceholder")}
              aria-label={t("action", "filterRoutes")}
              className="w-52"
            />
            <Select
              value={kind === "" ? ALL_KINDS : kind}
              onValueChange={(value) => {
                const chosen = ROUTE_KINDS.find((k) => k === value);
                setSearch({
                  kind: chosen && toPlural(chosen),
                  listOf: undefined,
                });
              }}
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
              aria-pressed={showMap}
              onClick={() => setShowMap((on) => !on)}
            >
              <MapGlyph className="mr-1.5 h-3.5 w-3.5" />
              {showMap ? t("action", "hideMap") : t("action", "map")}
            </Button>
          </div>
        }
      />

      {named && !isLoading && (
        <div className="mt-3">
          <NamedRowsBanner
            named={named}
            found={narrowed.length}
            whole={!error && unread.length === 0 && refusedKinds.length === 0}
          />
        </div>
      )}

      <div className="mt-3 empty:hidden">
        <UnreadNamespaces
          unread={unread}
          label={t("nav", "routes").toLowerCase()}
        />
        {!error &&
          refusedKinds.map(({ kind: refused, error: why }) => (
            <Unknown
              key={refused}
              className="mb-2"
              question={t("empty", "couldNotReadInScope", { label: refused })}
              error={why}
            />
          ))}
      </div>

      {failedRefresh !== null && routes.length > 0 && (
        <StaleRows
          className="mt-3"
          label={t("nav", "routes").toLowerCase()}
          since={dataUpdatedAt}
          error={failedRefresh}
          onRetry={() => void refetch()}
        />
      )}

      {/* Every pulse is a break upstream of the routes: the sidebar's dot says err. */}
      {pulse.map((entry) => (
        <Alert
          key={`${entry.namespace}/${entry.gateway}`}
          variant="destructive"
          className="mt-3 flex items-baseline gap-2"
        >
          <span className="text-fg-mid">
            {parts(t("empty", "gwPulseLine", { say: entry.say }), {
              name: <span className="font-mono text-fg">{entry.gateway}</span>,
            })}
          </span>
          <Link
            {...listLink("Gateway")}
            className="ml-auto whitespace-nowrap text-info hover:underline"
          >
            {t("action", "openGateways")}
          </Link>
        </Alert>
      ))}

      {showMap && (
        // Bounded and shrink-proof: as a full-height sibling of the only
        // scroller, the map left the route list a box 0px tall.
        <div className="mt-3 flex max-h-[45%] shrink-0 flex-col gap-1 overflow-y-auto scrollbar-lane">
          {topology.columns[topology.spine ?? 1].nodes.length === 0 ? (
            <p className="max-w-[64ch] text-xs text-fg-mut">
              {t("empty", "gwNothingToDraw")}
            </p>
          ) : (
            <RoutingMap data={topology} />
          )}
        </div>
      )}

      {/* A floor: whatever is above it, the list stays a list. */}
      <div className="min-h-[8rem] flex-1 overflow-y-auto scrollbar-lane">
        {error && routes.length === 0 ? (
          <UnreadList
            error={error}
            words={
              refused
                ? t("nav", "noListAccess")
                : t("empty", "gwCouldNotReadRoutes")
            }
            onRetry={() => void refetch()}
          />
        ) : isLoading && routes.length === 0 ? (
          <div role="status" aria-busy="true">
            <TableSkeleton
              widths={[28, 255, 320, 84, 170, 105, 50]}
              rows={8}
              showSearch={false}
              compact
            />
          </div>
        ) : detectionError ? (
          // Every kind query is gated on the CRD scan, so a scan that failed
          // leaves this page with an empty list and nothing to say about it.
          // "No routes in the current scope" would be a claim about a cluster
          // nobody managed to ask.
          <UnreadList
            error={detectionError}
            words={t("empty", "gwCouldNotCheckInstall")}
            onRetry={() => void refetchScan()}
          />
        ) : detectionLoading ? (
          <Reading className="py-8">{t("empty", "gwCheckingInstall")}</Reading>
        ) : total + board.mesh.length === 0 ? (
          <EmptyState
            action={
              routes.length > 0 ? (
                <Button
                  variant="ghost"
                  className="text-xs"
                  onClick={() => {
                    setQuery("");
                    setBrokenOnly(false);
                    setSearch({
                      kind: undefined,
                      listOf: undefined,
                      names: undefined,
                    });
                  }}
                >
                  {t("empty", "clearFilters")}
                </Button>
              ) : undefined
            }
          >
            {routes.length > 0
              ? t("empty", "nothingMatchesFilter")
              : unread.length > 0
                ? noneWhereAnswered(
                    t,
                    t("nav", "routes").toLowerCase(),
                    scope.scope,
                    unread
                  )
                : refusedKinds.length > 0
                  ? t("empty", "gwNoRoutesOfKindsRead")
                  : t("empty", "gwNoRoutesInScope")}
          </EmptyState>
        ) : !board.verdictsKnown ? (
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
            {!brokenOnly && (
              <UnsettledRows
                rows={[...board.unknown, ...board.serving, ...board.mesh]}
                // Still reading and could not read both leave `data`
                // undefined, but they are not the same thing to wait for.
                why={
                  gateways.error || classes.error
                    ? t("empty", "gwCouldNotReadVerdicts")
                    : backing.error
                      ? t("empty", "gwCouldNotReadBacking")
                      : t("empty", "gwReadingVerdicts")
                }
                reading={!gateways.error && !classes.error && !backing.error}
              />
            )}
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
            {!brokenOnly && board.unknown.length > 0 && (
              <>
                <GroupCap
                  label={t("empty", "gwGroupUnknown")}
                  count={board.unknown.length}
                />
                <div className="border-t border-hair">
                  {board.unknown.map((row) => (
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
