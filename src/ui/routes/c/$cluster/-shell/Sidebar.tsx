import * as React from "react";
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChevronsDown,
  CircleOff,
  FolderOpen,
  LayoutDashboard,
  Library,
  Lock,
  Package,
  Plug,
  Route,
  Settings,
  ShieldUser,
  type LucideIcon,
  History,
} from "lucide-react";

import { ClusterMenu } from "@/components/cluster/ClusterMenu";
import { ProviderMark } from "@/components/ui/provider-mark";
import { Spinner } from "@/components/ui/spinner";
import {
  ATTENTION_TEXT,
  attentionFigure,
  attentionWords,
  type Attention,
} from "@/lib/attention";
import {
  oneLock,
  refusedEverywhereAsked,
  useListLocks,
  useLocks,
  type Lock as ListLock,
} from "./useListAccess";
import { useShellCounts, type ShellCounts } from "./useShellCounts";
import { useWindowCluster } from "./useWindowCluster";
import { useAppSearchValue } from "@/hooks/useSearchParam";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useListFollowed, useListLive } from "@/hooks/useWatchedList";
import { useReadAt } from "@/hooks/useReadUid";
import { useDoorAsk } from "@/hooks/useDoorAsk";
import { useGatewayApi } from "@/hooks/useGatewayApi";
import { GATEWAY_ROUTE_KINDS } from "../-object/useGatewayRoutes";
import {
  backingFrom,
  ROUTING_STALE,
  useBackingLists,
  useIntegrationPages,
} from "@/integrations";
import { wake } from "@/hooks/useClusterForwards";
import { useClusterForwardStore } from "@/stores/clusterForwardStore";
import { detectProvider } from "@/lib/cluster-identity";
import {
  ResourceType,
  getDisplayPlural,
  getResourceIcon,
  narrowingHelps,
  listQueryFor,
  type ResourceKind,
} from "@/lib/resource-registry";
import { NOTHING_MISSING, type ScopeMissing } from "@/hooks/useScopeMissing";
import { listWords } from "@/i18n/say";
import { ACCESS_KINDS, type AccessKind } from "@/lib/access-kinds";
import {
  clusterLink,
  listLink,
  pageLink,
  servedListLink,
  type AppLink,
} from "@/lib/links";
import type { en } from "@/i18n/catalogue";
import { T } from "@/i18n/T";
import { cn, formatWhen } from "@/lib/utils";
import { commands } from "@/lib/commands";
import { EVERY_NAMESPACE, queryKeys } from "@/lib/query-keys";
import { boardMark, gatewaysMark, routesBoard } from "@/lib/route-rows";
import { useClusterMark } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";
import {
  inScope,
  joinScoped,
  scopeCacheKey,
  wireScope,
} from "@/lib/namespace-scope";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUpdaterStore } from "@/stores/updaterStore";
import type {
  EventInfo,
  ListQuery,
  PartialCount,
  ResourceCounts,
  Scoped,
} from "@/generated/types";
import { errorWords } from "@/i18n/say";
import { useT, type T as Translate } from "@/i18n/useT";

type NavKey = keyof typeof en.nav;

/**
 * A row names itself one of two ways, and must pick exactly one.
 *
 * A resource row's label is the kind's own plural — a proper noun that reads
 * the same in every language, so it stays a literal. The app's own rows are
 * ordinary words and carry a catalogue key. The union is what stops a third
 * case: a row with neither, which renders as a clickable blank.
 */
type NavName =
  | { label: string; labelKey?: never }
  | { labelKey: NavKey; label?: never };

type NavItem = NavName & {
  path: AppLink;
  icon: LucideIcon;
  /** Which of the backend's counts belongs at the end of this row. */
  count?: keyof ResourceCounts;
  /** The kind this row lists, for the rows that list one. */
  kind?: ResourceKind;
  /** What the authorizer is asked, for a row listing a kind outside the registry. */
  query?: ListQuery;
};

// Split by state because the router joins a link's state classes onto it
// without merging them, so the two text colours must never meet.
const ROW_FOCUS_CLASS =
  "transition-colors hover:bg-hover outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-info";
// The scroll margin outdoes the rail's 24px fades, so a focused row lands clear of them.
const ROW_BASE_CLASS = `group flex scroll-my-7 items-center gap-[9px] rounded-[5px] px-2 py-1 text-[12px] leading-[15px] ${ROW_FOCUS_CLASS}`;
const ROW_SHUT_CLASS = "text-fg-mid";
const ROW_CLASS = `${ROW_BASE_CLASS} ${ROW_SHUT_CLASS}`;
const ROW_OPEN_CLASS = "bg-sel font-medium text-fg";
// The icon sits a step below the label in contrast: it aids recognition
// without competing with it. Only the open row lifts it, which is what
// marks the row rather than the fill.
const ICON_CLASS =
  "h-3.5 w-3.5 text-fg-fnt transition-colors group-hover:text-fg-mut";
const ICON_OPEN_CLASS = "text-info group-hover:text-info";

/** A row whose label, route and icon all come from the resource registry. */
function resource(kind: ResourceKind, count?: keyof ResourceCounts): NavItem {
  return {
    kind,
    label: getDisplayPlural(kind),
    path: listLink(kind),
    icon: getResourceIcon(kind),
    count,
  };
}

/** A row for a kind the registry does not hold, listed as kubectl prints it. */
function servedRow(entry: AccessKind): NavItem {
  return {
    label: entry.displayPlural,
    path: servedListLink(entry),
    icon: entry.icon,
    count: entry.count,
    query: {
      group: entry.group,
      resource: entry.plural,
      namespaced: entry.namespaced,
    },
  };
}

/**
 * The nav, in reading order.
 *
 * One rule for the numbers: a row shows one only for a kind the overview's
 * count request already returns, and nothing for a kind it does not count
 * or could not read, never a 0 it did not measure.
 *
 * A group is a caption, not a control: the resources under it are what the
 * sidebar is for, and hiding them behind a disclosure the user has to open
 * on every launch made the panel a list of four words. Captioned groups
 * cost one line each and keep every destination one click away.
 */
const GROUPS: { caption?: NavKey; items: NavItem[] }[] = [
  {
    items: [
      { labelKey: "overview", path: clusterLink(), icon: LayoutDashboard },
      resource(ResourceType.Event, "events"),
      { labelKey: "changes", path: pageLink("changes"), icon: History },
    ],
  },
  {
    caption: "workloads",
    items: [
      resource(ResourceType.Pod, "pods"),
      resource(ResourceType.Deployment, "deployments"),
      resource(ResourceType.StatefulSet, "statefulSets"),
      resource(ResourceType.DaemonSet, "daemonSets"),
      resource(ResourceType.Job, "jobs"),
      resource(ResourceType.CronJob, "cronJobs"),
    ],
  },
  {
    caption: "cluster",
    items: [
      resource(ResourceType.Node, "nodes"),
      resource(ResourceType.Namespace, "namespaces"),
      resource(ResourceType.CustomResourceDefinition),
      {
        labelKey: "apiResources",
        path: pageLink("api-resources"),
        icon: Library,
      },
      { label: "Helm", path: pageLink("helm"), icon: Package },
    ],
  },
  {
    caption: "network",
    items: [
      resource(ResourceType.Service, "services"),
      // Services name the endpoints behind each one; this is the only place
      // that answers "what is behind everything at once" — which is the
      // question asked when it is not yet known which Service is wrong.
      resource(ResourceType.Endpoints, "endpoints"),
      resource(ResourceType.Ingress, "ingresses"),
      resource(ResourceType.NetworkPolicy, "networkPolicies"),
    ],
  },
  {
    caption: "storage",
    items: [
      resource(ResourceType.PersistentVolumeClaim, "persistentVolumeClaims"),
      resource(ResourceType.PersistentVolume),
      resource(ResourceType.StorageClass),
    ],
  },
  {
    caption: "config",
    items: [
      resource(ResourceType.ConfigMap, "configMaps"),
      resource(ResourceType.Secret, "secrets"),
    ],
  },
  {
    caption: "access",
    items: [
      { labelKey: "myAccess", path: pageLink("my-access"), icon: ShieldUser },
      ...ACCESS_KINDS.map(servedRow),
    ],
  },
];

/**
 * The catalog itself, `/c/<cluster>/integrations`. Every vendor without a
 * screen of its own shares that address, so which row is open is a question
 * about `?vendor=`.
 */
const isCatalogLocation = (state: { location: { pathname: string } }) => {
  const [, , page, ...rest] = state.location.pathname
    .split("/")
    .filter(Boolean);
  return page === "integrations" && rest.length === 0;
};

/** Every kind the nav offers, which is exactly what to ask the authorizer about. */
const NAV_KINDS: ResourceKind[] = GROUPS.flatMap((group) =>
  group.items.map((item) => item.kind).filter((kind) => kind !== undefined)
);
const NAV_QUERIES: ListQuery[] = GROUPS.flatMap((group) =>
  group.items.map((item) => item.query).filter((query) => query !== undefined)
);

/**
 * The app's own row, pinned under the scroll rather than at the end of it.
 *
 * Everything above this line is about the connected cluster — its
 * workloads, its network, what it has installed. This is about the app
 * itself, and the split is drawn where it is felt: a fixed strip at the
 * rail's foot, reachable without scrolling past eighty pods to find it.
 *
 * Not a link: Settings is a layer over the window, so the row opens it in
 * place and the page behind stays where it was. The dot is a deep link,
 * not a decoration: it says an update is waiting, so it opens where the
 * update is, the one pane the last-open section may say nothing about.
 */
function SettingsRow() {
  const open = useSettingsStore((state) => state.open);
  const openSettings = useSettingsStore((state) => state.openSettings);
  const updateAvailable = useUpdaterStore((state) => state.available);

  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => openSettings(updateAvailable ? "about" : undefined)}
      className={cn(ROW_CLASS, "w-full", open && ROW_OPEN_CLASS)}
    >
      <div className="relative flex-none">
        <Settings className={cn(ICON_CLASS, open && ICON_OPEN_CLASS)} />
        {updateAvailable && (
          <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-err" />
        )}
      </div>
      <span>
        <T section="nav" k="settings" />
      </span>
    </button>
  );
}

const RAIL_FADE = {
  above: "[mask-image:linear-gradient(to_bottom,transparent,black_24px)]",
  below:
    "[mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]",
  both: "[mask-image:linear-gradient(to_bottom,transparent,black_24px,black_calc(100%-24px),transparent)]",
} as const;

/** Rows whose foot is past the rail's lower edge, the one the edge cuts included. */
function rowsBelow(rail: HTMLElement) {
  const edge = rail.getBoundingClientRect().bottom;
  let n = 0;
  for (const row of rail.querySelectorAll("a[href]"))
    if (row.getBoundingClientRect().bottom > edge + 1) n += 1;
  return n;
}

/** Fades the edge the rail continues past, so a caption the edge cuts reads as more to come rather than as broken. */
function useRailFade() {
  const [fade, setFade] = React.useState<keyof typeof RAIL_FADE | null>(null);
  const [below, setBelow] = React.useState(0);
  const [rail, setRail] = React.useState<HTMLElement | null>(null);
  const attach = React.useCallback((rail: HTMLElement | null) => {
    setRail(rail);
    if (!rail) return;
    const measure = () => {
      const above = rail.scrollTop > 0;
      const below = rail.scrollTop + rail.clientHeight < rail.scrollHeight - 1;
      setFade(
        above && below ? "both" : above ? "above" : below ? "below" : null
      );
      setBelow(below ? rowsBelow(rail) : 0);
    };
    measure();
    rail.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(rail);
    if (rail.firstElementChild) observer?.observe(rail.firstElementChild);
    return () => {
      rail.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);
  const more = () =>
    rail?.scrollBy({ top: rail.clientHeight * 0.8, behavior: "smooth" });
  return [attach, fade && RAIL_FADE[fade], below, more] as const;
}

/**
 * Says the rail goes on past the App block, where a faded row alone read as
 * clipped. A band across the rail's foot, short of its scrollbar, so a
 * caption the edge cuts is under it rather than a ghost beside it.
 */
function RailMore({ n, onClick }: { n: number; onClick: () => void }) {
  const t = useT();
  if (n === 0) return null;
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onClick}
      className="absolute bottom-0 left-0 right-2 flex h-[18px] items-center justify-end gap-1 bg-canvas px-1.5 text-[10px] leading-[13px] text-fg-fnt transition-colors hover:bg-hover hover:text-fg"
    >
      <ChevronsDown className="h-3 w-3" aria-hidden="true" />
      {t("count", "railRowsBelow", { n })}
    </button>
  );
}

export function Sidebar({
  missing = NOTHING_MISSING,
}: {
  /** The namespaces of the scope the cluster does not have. */
  missing?: ScopeMissing;
}) {
  const [attachRail, railFade, rowsPast, scrollRail] = useRailFade();
  const counts = useShellCounts();
  const locks = useListLocks(NAV_KINDS);
  const servedLocks = useLocks(NAV_QUERIES);

  return (
    <aside className="flex w-52 flex-col overflow-hidden border-r border-hair">
      <ClusterRow />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <nav
          ref={attachRail}
          className={cn(
            // In a lane: WebKit's overlay scrollbar lay over the counts and
            // lock marks and took their pointer.
            "min-h-0 flex-1 overflow-y-auto scrollbar-lane px-1.5 pb-2.5 pt-1",
            railFade
          )}
        >
          <div>
            {GROUPS.map((group, index) => (
              <div key={group.caption ?? `ungrouped-${index}`}>
                {group.caption && <GroupCaption k={group.caption} />}
                {group.items.map((item) => (
                  <NavRow
                    key={item.labelKey ?? item.label}
                    item={item}
                    counts={counts}
                    missing={missing}
                    lock={
                      item.kind
                        ? locks[item.kind]
                        : item.query
                          ? servedLocks.get(item.query.resource)
                          : undefined
                    }
                  />
                ))}
                {group.caption === "network" && <GatewayRows />}
              </div>
            ))}
            <IntegrationsGroup />
          </div>
        </nav>
        <RailMore n={rowsPast} onClick={scrollRail} />
      </div>
      {/* The app's own strip, outside the scroll: the rows above are the
          cluster's and travel with it; these stay put on every screen. */}
      <div className="border-t border-hair px-1.5 pb-2.5">
        <GroupCaption k="app" />
        <SettingsRow />
      </div>
    </aside>
  );
}

/**
 * The Gateway API rows, drawn only where the cluster serves the kinds.
 *
 * Not static entries in `GROUPS`, on purpose: the kinds are CRDs a cluster
 * may not have, and rows of empty lists on every Ingress-only cluster
 * would be the rail claiming a routing layer that is not there. The scan is
 * the same one-per-cluster answer every gateway surface reads.
 *
 * Two rows, not seven. The five route kinds share one list page — the
 * reader's question is "what routes into this cluster", and five rows
 * mostly holding zero each answered a question nobody asked. Each kind
 * stays first-class past the door: its own detail page, its own address,
 * its own name on every row.
 */

function GatewayRows() {
  const t = useT();
  // The whole selection, not the collapsed `currentNamespace` — that is `""`
  // for any two-or-more namespace window, which narrows to the whole cluster
  // and put "Routes 40" in the rail above a page (migrated to read per
  // namespace) listing three. `inScope` narrows by the array for one or
  // several, and is the identity for an empty selection.
  const scope = useClusterStore((s) => s.namespaceScope);
  const detection = useGatewayApi().data;
  const installed = detection?.installed ?? false;
  const served = new Set(detection?.kinds.map((k) => k.kind) ?? []);
  // Constructed exactly the way GatewayDetail constructs it, so the two
  // share one cache entry rather than fetching the same lists twice.
  const routeKinds = (detection?.kinds ?? [])
    .map((kind) => kind.kind)
    .filter((kind) =>
      (GATEWAY_ROUTE_KINDS as readonly string[]).includes(kind)
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
  const routesLock =
    routeKinds.length > 0 && routeLocks.length === routeKinds.length
      ? oneLock(routeLocks)
      : undefined;

  const cacheKey = scopeCacheKey(scope);

  // Verdict sources, read cluster-wide on purpose: a route can attach to a
  // Gateway (or a GatewayClass) in a namespace the window is not on, and a
  // verdict computed without it is wrong. These are the same keys the routes
  // list and the trace read, so the pages share the answer. A namespace-scoped
  // token is refused them — the board reads that absence as `topologyKnown:
  // false` and asserts nothing, rather than a red dot for what it cannot see.
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
      const refused = settled.find((r) => r.status === "rejected");
      if (refused && answered.length === 0) {
        throw (refused as PromiseRejectedResult).reason;
      }
      return { ...joinScoped(answered), complete: refused === undefined };
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
  // The subject list is scoped, and now read that way rather than narrowed
  // from a cluster-wide list — an RBAC token that cannot list cluster-wide
  // still gets its own namespaces' rows. The verdict sources stay cluster-wide
  // (above): a route can attach to a Gateway in a namespace the window is not
  // on, and a verdict computed without it is wrong.
  const scopedRoutes = useMemo(
    () => (routes.data?.rows ?? []).filter((r) => inScope(scope, r.namespace)),
    [routes.data, scope]
  );
  // The count follows the scope; on a whole-cluster window the verdict read
  // already is that list, so reuse it and skip the second fetch.
  const counted =
    scope.length === 0 ? gatewaysAll.data : gatewaysScoped.data?.rows;
  const scopedGateways = useMemo(
    () => (counted ?? []).filter((g) => inScope(scope, g.namespace)),
    [counted, scope]
  );
  const board = useMemo(
    () =>
      routesBoard(
        scopedRoutes,
        {
          // Cluster-wide, deliberately: the verdict for a scoped route can
          // depend on a Gateway or class in another namespace. Refused for a
          // namespace-scoped token -> `topologyKnown` false -> no verdict.
          gateways: gatewaysAll.data ?? [],
          classes: classes.data ?? [],
          // Classes count as read only once their list answered (or the
          // kind is not served at all) — a gateway judged against an
          // empty class list reads "class does not exist", which would
          // put a red dot on a healthy cluster for one render.
          topologyKnown: gatewaysAll.data !== undefined && classesSettled,
          backing: backingFrom(backing.data, backing.error),
          door,
        },
        t
      ),
    [
      scopedRoutes,
      gatewaysAll.data,
      classes.data,
      backing.data,
      backing.error,
      classesSettled,
      door,
      t,
    ]
  );

  const scopedPulse = board.pulse.filter((p) => inScope(scope, p.namespace));

  if (!installed) return null;

  return (
    <>
      {served.has("Gateway") && (
        <NavRow
          item={resource(ResourceType.Gateway)}
          // No number where a namespace was not read: it would not be the
          // scope's total.
          value={
            counted && !gatewaysScoped.data?.unread.length
              ? scopedGateways.length
              : null
          }
          mark={gatewaysMark(
            scopedGateways,
            scopedPulse,
            gatewaysAll.data !== undefined && classesSettled
          )}
          lock={gatewaysLock}
        />
      )}
      {routeKinds.length > 0 && (
        <NavRow
          item={{ labelKey: "routes", path: pageLink("routes"), icon: Route }}
          value={
            routes.data?.complete && routes.data.unread.length === 0
              ? scopedRoutes.length
              : null
          }
          mark={boardMark(board)}
          lock={routesLock}
        />
      )}
    </>
  );
}

/**
 * A caption takes the catalogue key rather than the finished words.
 *
 * The spinner needs the caption twice — once drawn, once spoken — and a
 * translated caption arrives as an element, which cannot be lowercased for
 * the label. Holding the key instead means both come from the same lookup
 * and neither can drift from the other.
 */
function GroupCaption({ k, busy = false }: { k: NavKey; busy?: boolean }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-3 text-[10px] font-semibold uppercase leading-[13px] tracking-[0.07em] text-fg-fnt">
      <T section="nav" k={k} />
      {busy && (
        <Spinner
          aria-label={t("action", "readingGroup", {
            group: t("nav", k).toLowerCase(),
          })}
          className="h-2.5 w-2.5"
        />
      )}
    </div>
  );
}

/**
 * The cluster's own category: what it has, then the door to the catalog.
 *
 * The vendor rows name what *this* cluster happens to have installed or
 * connected; the last row is the Integrations page itself — the inventory
 * of everything the app knows, installed or not — which used to hide
 * inside Settings and is the one row here that never disappears.
 *
 * A row whose vendor owns no screen goes to its catalog row instead of
 * being dropped — several of them share one route, which is why those rows
 * decide their own highlight from the query string rather than letting
 * the router light all of them at once.
 */
function IntegrationsGroup() {
  const t = useT();
  const onCatalog = useRouterState({ select: isCatalogLocation });
  const vendor = useAppSearchValue("vendor") ?? null;
  const { pages, pending, reading } = useIntegrationPages();
  const context = useClusterStore((state) => state.currentContext);
  const saved = useClusterForwardStore((state) => state.forwards);
  const queryClient = useQueryClient();
  const [waking, setWaking] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);

  // The catalog is the category's own door — the inventory of everything
  // the app knows, installed or not — so the group always draws, even on a
  // cluster with nothing detected: "this cluster has none of these" is an
  // answer that page owns, not a reason to hide the way to it.
  const catalog = (
    <NavRow
      item={{
        labelKey: "allIntegrations",
        path: pageLink("integrations"),
        icon: Plug,
      }}
      value={null}
      active={onCatalog && vendor === null}
    />
  );

  // Detection still running is not "no integrations" — the rail holds the
  // group's shape instead of popping it in a second later.
  if (pages.length === 0 && pending) {
    return (
      <div>
        <GroupCaption k="integrations" busy={reading} />
        <div aria-hidden>
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center gap-2 px-2 py-[5px]">
              <div className="size-3.5 animate-pulse rounded bg-hover" />
              <div className="h-2.5 w-20 animate-pulse rounded bg-hover" />
            </div>
          ))}
        </div>
        {catalog}
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div>
        <GroupCaption k="integrations" busy={reading} />
        {catalog}
      </div>
    );
  }

  // Pressing a sleeping row is what opens its tunnel. The navigation is not
  // held up for it — the page has its own pending and error states, and a
  // sidebar row that swallowed a click for two seconds would read as broken.
  const press = (id: string) => {
    const preference = context ? saved[context]?.[id] : undefined;
    if (!preference) return;
    setWaking(id);
    setFailed(null);
    void wake(id, preference)
      // Everything cached was read while the tunnel was down — the probe
      // that said unreachable, the page verdicts built on a dead socket,
      // the address itself if the forward moved ports. A row that stayed
      // "asleep" after a successful wake is this cache, not the tunnel.
      .then(() => queryClient.invalidateQueries())
      .catch((error: unknown) => setFailed(errorWords(error, t)))
      .finally(() => setWaking(null));
  };

  const row = (page: (typeof pages)[number]) => (
    <NavRow
      key={page.id}
      item={{ label: page.name, path: page.link, icon: page.icon }}
      value={page.count}
      mark={page.tone ?? undefined}
      // Detected but refused: the row is drawn disabled with a vendor
      // reason instead of linking to a page that only errors.
      lock={page.forbidden ? REFUSED : undefined}
      deniedReason={
        page.forbidden
          ? t("nav", "noVendorAccess", { vendor: page.name })
          : undefined
      }
      // A tunnel that is down is not a count and not a fault: it is a
      // thing this row can do something about, and says so.
      note={
        page.asleep
          ? waking === page.id
            ? t("cluster", "tunnelWaking")
            : t("cluster", "tunnelAsleep")
          : undefined
      }
      onPress={page.asleep ? () => press(page.id) : undefined}
      active={page.own ? undefined : onCatalog && vendor === page.id}
    />
  );
  const operators = pages.filter((page) => page.operator);

  return (
    <div>
      <GroupCaption k="integrations" busy={reading} />
      {pages.filter((page) => !page.operator).map(row)}
      {/* Operators are integrations too, one folder like the rest, but a
          reader looking for their database looks for that word. */}
      {operators.length > 0 && <GroupCaption k="operators" />}
      {operators.map(row)}
      {failed && (
        <p className="px-2 pb-1 text-[10px] leading-snug text-err">{failed}</p>
      )}
      {catalog}
    </div>
  );
}

/**
 * The top row names the cluster, not the product.
 *
 * Which cluster this window is pointed at is the fact that decides whether a
 * command is routine or an outage; the product's own name is something the
 * user already knows and can never act on.
 *
 * It is also the one place a rename is not allowed to win outright. The tab
 * strip and the front door can show a nickname alone because both are one
 * hover or one glance from the truth; this row is on screen the whole time
 * and is what somebody checks before they run something. So a renamed
 * cluster gets both lines here — the name they gave it, and under it, at
 * the faintest contrast the theme has, the context name itself.
 *
 * It is also where the rename is *made*. This row is the most permanent
 * mention of the cluster in the app, so it is where somebody looks for what
 * to call it and what colour it wears; the same menu hangs off the tab strip
 * and the cluster list, and right-click alone was a gesture you had to
 * already know about. Left click opens it here because the row has nothing
 * else a click could mean — the cluster is already the one you are on.
 */
function ClusterRow() {
  const t = useT();
  const { context: currentContext, live: connected } = useWindowCluster();
  const alias = useClusterMark(currentContext).alias?.trim();
  const isLoading = useClusterStore((s) => s.isLoading);
  const isAuthenticating = useClusterStore((s) => s.isAuthenticating);

  const connecting = isLoading || isAuthenticating;

  const body = (
    <>
      <ProviderMark
        data-window-cluster="mark"
        provider={detectProvider(currentContext ?? "")}
        className="h-[15px] w-[15px] flex-none"
        style={{ color: "var(--cluster)" }}
      />
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-[12px] font-semibold leading-[15px] text-fg">
          {alias ?? currentContext ?? t("cluster", "noCluster")}
        </span>
        {alias && currentContext && (
          // Clipped from the front, not the back. This rail is 200px wide
          // and an ARN spends its first thirty characters on a region and
          // an account number; cut the usual way it reads
          // `arn:aws:eks:us-east-1:1…`, which is the half that cannot tell
          // prod from staging. `direction: rtl` moves the ellipsis to the
          // start and leaves the run itself in order, because the name is
          // ASCII from end to end.
          <span className="truncate text-left font-mono text-[10px] leading-[12px] text-fg-fnt [direction:rtl]">
            {currentContext}
          </span>
        )}
      </span>
      {/* The halo is what makes a 7px dot readable in peripheral vision,
          which is the only way this indicator is ever looked at. */}
      <span
        data-window-cluster="dot"
        aria-label={
          connected ? "connected" : connecting ? "connecting" : "disconnected"
        }
        className={cn(
          "ml-auto h-[7px] w-[7px] flex-none rounded-full",
          !connected && (connecting ? "bg-warn" : "bg-fg-fnt")
        )}
        style={
          connected
            ? {
                background: "var(--cluster)",
                boxShadow:
                  "0 0 0 3px color-mix(in srgb, var(--cluster) 22%, transparent)",
              }
            : undefined
        }
      />
    </>
  );

  // Inset and rounded like the rows below it, so its focus ring is theirs
  // rather than a hairline along the window's edge.
  const row =
    "flex h-[30px] w-full items-center gap-2 rounded-[5px] px-1 text-left";

  // Nothing to configure about a cluster there is none of, and a menu that
  // renamed `null` would write a mark under an empty key.
  return (
    <div className="flex-none px-1.5 py-1">
      {currentContext ? (
        <ClusterMenu context={currentContext} openOnClick>
          <button
            type="button"
            aria-haspopup="menu"
            aria-label={t("cluster", "renameOrRecolour", {
              name: alias ?? currentContext,
            })}
            className={cn(row, ROW_FOCUS_CLASS)}
          >
            {body}
          </button>
        </ClusterMenu>
      ) : (
        <div className={row}>{body}</div>
      )}
    </div>
  );
}

const REFUSED: ListLock = { says: "refused" };

const readableIn = (lock: ListLock) =>
  lock.says === "clusterWide" && lock.readableIn.length > 0;

/**
 * A word would not fit beside "Persistent Volumes" in a rail this narrow, so
 * the glyph says which lock it is: a padlock for a refusal, a namespace for a
 * list refused across the cluster that a namespace the reader has still lists.
 */
function LockMark({ lock, reason }: { lock: ListLock; reason?: string }) {
  const t = useT();
  const words =
    lock.says === "refused"
      ? (reason ?? t("nav", "noListAccess"))
      : lock.readableIn.length > 0
        ? t("empty", "listableIn", {
            n: lock.readableIn.length,
            namespaces: lock.readableIn.join(", "),
          })
        : refusedEverywhereAsked(lock)
          ? t("empty", "refusedClusterWideAndIn", {
              n: lock.refusedIn.length,
              namespaces: lock.refusedIn.join(", "),
            })
          : t("empty", "refusedAcrossCluster");
  const Icon = readableIn(lock) ? FolderOpen : Lock;
  return (
    <Icon
      className={cn(
        "ml-auto h-3 w-3 flex-none",
        readableIn(lock) ? "text-info" : "text-fg-fnt"
      )}
      aria-label={words}
    >
      <title>{words}</title>
    </Icon>
  );
}

function NavRow({
  item,
  counts,
  missing,
  value,
  mark,
  note,
  lock,
  deniedReason,
  onPress,
  active,
}: {
  item: NavItem;
  counts?: ShellCounts;
  missing?: ScopeMissing;
  /** A count this row carries itself, for a row the overview knows nothing about. */
  value?: number | null;
  /**
   * A dot beside the count: the worst thing on the row's page, or nothing.
   * The count itself stays quiet — inventory is not allowed to borrow a
   * colour — so this one pixel is the row's whole opinion.
   */
  mark?: "warn" | "err" | "unchecked";
  /**
   * The authorizer says this reader may not list what the row leads to, in
   * the scope asked.
   *
   * Drawn, never enforced: the row stays a link and the list call stays the
   * authority. A review that is wrong then costs a mark the next answer
   * clears, rather than a screen somebody cannot open.
   */
  lock?: ListLock;
  /**
   * Why the row is denied, when a kind-agnostic row (an integration) can say
   * something more specific than the generic "no permission to list". Falls
   * back to `nav.noListAccess` for the resource rows that carry a kind.
   */
  deniedReason?: string;
  /**
   * A word at the end of the row instead of a count — for a state that is
   * neither a number nor a fault. A port-forward that is down is the case
   * this exists for: it is something the row can do something about.
   */
  note?: string;
  /**
   * Something to do *besides* navigating, run on the way. The row is still a
   * link and still goes where it says; this does not replace the navigation
   * and must never wait for anything before it.
   */
  onPress?: () => void;
  /**
   * Whether this row is the open one, where the path alone cannot say. Left
   * undefined the router decides, which is right for every row that owns its
   * own route.
   */
  active?: boolean;
}) {
  const t = useT();
  const overviewRow = item.labelKey === "overview";

  const isOpen = (routerSaysActive: boolean) => active ?? routerSaysActive;
  // A row that decides its own highlight takes nothing from the router's.
  const routerDecides = active === undefined;

  return (
    <Link
      {...item.path}
      activeOptions={{ exact: overviewRow, includeSearch: false }}
      onClick={onPress}
      className={
        routerDecides ? ROW_BASE_CLASS : cn(ROW_CLASS, active && ROW_OPEN_CLASS)
      }
      activeProps={routerDecides ? { className: ROW_OPEN_CLASS } : {}}
      inactiveProps={routerDecides ? { className: ROW_SHUT_CLASS } : {}}
    >
      {({ isActive }) => (
        <>
          <div className="relative flex-none">
            <item.icon
              className={cn(ICON_CLASS, isOpen(isActive) && ICON_OPEN_CLASS)}
            />
          </div>
          <span className={cn(lock && !readableIn(lock) && "text-fg-fnt")}>
            {item.labelKey ? <T section="nav" k={item.labelKey} /> : item.label}
          </span>
          {lock && <LockMark lock={lock} reason={deniedReason} />}
          {note !== undefined ? (
            <span className="ml-auto text-[10px] text-fg-fnt">{note}</span>
          ) : value === undefined ? (
            counts &&
            (item.count === "events" ? (
              <EventsNavCount item={item} counts={counts} missing={missing} />
            ) : (
              <NavCount item={item} counts={counts} missing={missing} />
            ))
          ) : (
            value !== null && (
              <span className="ml-auto flex items-center gap-1.5 text-[11px] text-fg-fnt">
                {mark && (
                  // A hollow ring for "could not be checked", the same shape
                  // the tab strip wears: a page that says nobody looked had
                  // a plain number beside it here.
                  <span
                    // A label on a plain span is announced by nothing: the
                    // dot is the whole message here, so it says what it is.
                    role="img"
                    aria-label={
                      mark === "err"
                        ? t("cluster", "markBroken")
                        : mark === "warn"
                          ? t("cluster", "markWorthALook")
                          : t("cluster", "markUnchecked")
                    }
                    className={cn(
                      "h-1.5 w-1.5 flex-none rounded-full",
                      mark === "err"
                        ? "bg-err"
                        : mark === "warn"
                          ? "bg-warn"
                          : "border border-fg-fnt"
                    )}
                  />
                )}
                {value}
              </span>
            )
          )}
        </>
      )}
    </Link>
  );
}

/**
 * The Overview row's number: the same total its panel heads, in the colour
 * of the worst row in it. Uncapped: a headline that shrank when the
 * backend's ranked list overflowed would be the one number nobody can use.
 */
function AttentionCount({
  attention,
  counts,
}: {
  attention: Attention | null;
  counts: ShellCounts;
}) {
  const t = useT();
  if (!attention || (attention.complete && attention.total === 0)) return null;
  const { total: n, complete, worst } = attention;
  const behind = counts.heldAt !== null || counts.late;
  return (
    <span
      className={cn(
        "ml-auto flex items-center gap-1 text-[11px]",
        worst ? ATTENTION_TEXT[worst] : "text-fg-fnt",
        behind && HELD_CLASS
      )}
      title={
        behind || complete
          ? countAge(counts, false, t)
          : t("cluster", "problemsNotAllChecked")
      }
      aria-label={attentionWords({ total: n, complete }, t)}
    >
      {!complete && (
        <span
          aria-hidden="true"
          data-testid="attention-unchecked-ring"
          className="h-1.5 w-1.5 flex-none rounded-full border border-fg-fnt"
        />
      )}
      {attentionFigure(attention)}
    </span>
  );
}

/** The Events row: while the Events page's watch is live, its count is what that watch holds, so the row follows as the page does. */
function EventsNavCount(props: {
  item: NavItem;
  counts: ShellCounts;
  missing?: ScopeMissing;
}) {
  const scope = useClusterStore((s) => s.namespaceScope);
  const key = useMemo(
    () => [...queryKeys.events(scopeCacheKey(scope)), "watch"],
    [scope]
  );
  const live = useListLive(key);
  const held = useReadAt(key, (state) =>
    live
      ? (state?.data as Scoped<EventInfo> | undefined)?.rows.length
      : undefined
  );
  return <NavCount {...props} watched={held} />;
}

/**
 * The number at the end of a row.
 *
 * A count the cluster refused to hand over renders as nothing at all. `0`
 * is a measurement — "this namespace has no secrets" — and printing it for
 * a list the token may not read would state that as fact.
 */
function NavCount({
  item,
  counts,
  missing,
  watched,
}: {
  item: NavItem;
  counts: ShellCounts;
  missing?: ScopeMissing;
  /** The count a page's own live watch holds, which this row follows instead of the overview's. */
  watched?: number;
}) {
  const t = useT();
  const scope = useClusterStore((s) => s.namespaceScope);
  const pageList = useMemo(
    () => item.kind && pageListKey(item.kind, scope),
    [item.kind, scope]
  );
  const pageFollows = useListFollowed(pageList ?? null);
  const { overview, attention, heldAt, late, failed } = counts;
  const scoped = readsScope(item);
  // A namespace that is not there has no 0 to count.
  if (scoped && missing?.whole) return <ScopeMissingMark missing={missing} />;
  if (!overview) return null;

  if (item.labelKey === "overview")
    return <AttentionCount attention={attention} counts={counts} />;

  const count = watched ?? (item.count && overview.counts[item.count]);
  const age = [
    watched === undefined
      ? countAge(
          counts,
          pageFollows ||
            (item.count !== undefined && counts.followed.has(item.count)),
          t
        )
      : t("cluster", "countsFollowedLive"),
    item.count === "events" ? t("cluster", "eventsCountWindow") : null,
  ]
    .filter(Boolean)
    .join("\n");
  const behind = (heldAt !== null || late || failed) && HELD_CLASS;
  if (count == null) {
    const partial = overview.countsPartial?.find(
      (each) => each.count === item.count
    );
    return partial ? (
      <PartialCountMark partial={partial} age={age} className={behind} />
    ) : null;
  }
  return (
    <span
      className={cn("ml-auto text-[11px] text-fg-fnt", behind)}
      title={[
        age,
        scoped && missing && missing.missing.length > 0
          ? missingWords(missing, t)
          : null,
      ]
        .filter(Boolean)
        .join("\n")}
    >
      {count}
    </span>
  );
}

/** A count some namespaces of the scope answered and others refused: what was counted, as a floor, beside a lock. */
function PartialCountMark({
  partial,
  age,
  className,
}: {
  partial: PartialCount;
  age: string;
  className: string | false;
}) {
  const t = useT();
  const where = (names: readonly string[]) => listWords(names, t);
  const said = [
    t("cluster", "countPartialCounted", {
      n: partial.counted,
      names: where(partial.countedIn),
    }),
    partial.refusedIn.length > 0
      ? t("cluster", "countPartialRefused", { names: where(partial.refusedIn) })
      : null,
    partial.unreadIn.length > 0
      ? t("cluster", "countPartialUnread", { names: where(partial.unreadIn) })
      : null,
  ].filter(Boolean);
  return (
    <span
      className={cn(
        "ml-auto flex items-center gap-1 text-[11px] text-fg-fnt",
        className
      )}
      title={[...said, age].filter(Boolean).join("\n")}
      aria-label={t("cluster", "countPartialAtLeast", { n: partial.counted })}
      data-testid="partial-count"
    >
      <Lock className="h-2.5 w-2.5 flex-none" aria-hidden="true" />
      {`${partial.counted}+`}
    </span>
  );
}

/** Whether a row's count is of what the window's namespaces hold. */
function readsScope(item: NavItem): boolean {
  if (item.kind) return narrowingHelps(item.kind);
  if (item.query) return item.query.namespaced;
  return item.labelKey === "overview";
}

const missingWords = (missing: ScopeMissing, t: Translate) =>
  t("cluster", "scopeMissingCount", {
    n: missing.missing.length,
    names: listWords(missing.missing, t),
  });

function ScopeMissingMark({ missing }: { missing: ScopeMissing }) {
  const t = useT();
  const said = missingWords(missing, t);
  return (
    <span
      role="img"
      aria-label={said}
      title={said}
      data-testid="scope-missing-count"
      className="ml-auto text-fg-fnt"
    >
      <CircleOff className="h-3 w-3" aria-hidden="true" />
    </span>
  );
}

/** The list a kind's own page keeps in the window's scope, under the key its watch feeds. */
function pageListKey(kind: ResourceKind, scope: readonly string[]) {
  const cacheKey = listQueryFor(kind).namespaced ? scopeCacheKey(scope) : null;
  return kind === ResourceType.Pod
    ? queryKeys.podRows(cacheKey)
    : queryKeys.resources(kind, cacheKey);
}

/**
 * How old a count is, or that it follows the cluster: a number polled every
 * ten seconds beside a page that already says the object is gone read as now.
 */
function countAge(
  counts: ShellCounts,
  followed: boolean,
  t: Translate
): string {
  if (counts.heldAt !== null) return t("cluster", "countsHeld");
  if (counts.readAt === null) return "";
  const at = formatWhen(counts.readAt, "clock");
  if (counts.late) return t("cluster", "countsLate", { at });
  if (counts.failed) return t("cluster", "countsFailed", { at });
  if (followed) return t("cluster", "countsFollowed", { at });
  return counts.withinMs === false
    ? t("cluster", "countsAt", { at })
    : t("cluster", "countsEvery", {
        at,
        every: Math.round(counts.withinMs / 1000),
      });
}

/** A count from before the window turned to this cluster, or from before a read that is late. */
const HELD_CLASS = "opacity-60";
