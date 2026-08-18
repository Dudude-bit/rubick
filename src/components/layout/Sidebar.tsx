import * as React from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Package,
  Plug,
  Settings,
  type LucideIcon,
} from "lucide-react";

import { ClusterMenu } from "@/components/cluster/ClusterMenu";
import { ProviderMark } from "@/components/ui/provider-mark";
import { useScopedOverview } from "@/hooks/useClusterOverview";
import { useIntegrationPages } from "@/integrations";
import { wake } from "@/hooks/useClusterForwards";
import { useClusterForwardStore } from "@/stores/clusterForwardStore";
import { detectProvider } from "@/lib/cluster-identity";
import {
  ResourceType,
  getDisplayPlural,
  getResourceIcon,
  getResourceListUrl,
  type ResourceKind,
} from "@/lib/resource-registry";
import type { en } from "@/i18n/catalogue";
import { T } from "@/i18n/T";
import { cn } from "@/lib/utils";
import { useClusterMark } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useUpdaterStore } from "@/stores/updaterStore";
import type { ClusterOverview, ResourceCounts } from "@/generated/types";

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
  { label: string; labelKey?: never } | { labelKey: NavKey; label?: never };

type NavItem = NavName & {
  path: string;
  icon: LucideIcon;
  /** Which of the backend's counts belongs at the end of this row. */
  count?: keyof ResourceCounts;
  /**
   * The route prefix this row owns, where that is wider than where it goes.
   * Settings has five panes and one row; whichever pane the row happens to
   * open, all five must light it.
   */
  section?: string;
  /** Whether a waiting update puts its dot on this row. */
  updateBadge?: boolean;
};

/** Where a waiting update actually is. `/settings` opens on Appearance. */
const UPDATES_PATH = "/settings/about";

/** A row whose label, route and icon all come from the resource registry. */
function resource(kind: ResourceKind, count?: keyof ResourceCounts): NavItem {
  return {
    label: getDisplayPlural(kind),
    path: getResourceListUrl(kind),
    icon: getResourceIcon(kind),
    count,
  };
}

/**
 * The nav, in reading order.
 *
 * A group is a caption, not a control: the resources under it are what the
 * sidebar is for, and hiding them behind a disclosure the user has to open
 * on every launch made the panel a list of four words. Captioned groups
 * cost one line each and keep every destination one click away.
 */
const GROUPS: { caption?: NavKey; items: NavItem[] }[] = [
  {
    items: [
      { labelKey: "overview", path: "/", icon: LayoutDashboard },
      resource(ResourceType.Event, "events"),
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
      { label: "Helm", path: "/helm", icon: Package },
    ],
  },
  {
    caption: "network",
    items: [
      resource(ResourceType.Service, "services"),
      // Services name the endpoints behind each one; this is the only place
      // that answers "what is behind everything at once" — which is the
      // question asked when it is not yet known which Service is wrong.
      // No count: `ResourceCounts` has no endpoints field to read.
      resource(ResourceType.Endpoints),
      resource(ResourceType.Ingress, "ingresses"),
    ],
  },
  {
    caption: "storage",
    items: [
      resource(ResourceType.PersistentVolumeClaim),
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
];

/**
 * The app's own rows, pinned under the scroll rather than at the end of it.
 *
 * Everything above this line is about the connected cluster — its
 * workloads, its network, what it has installed. These are about the app
 * itself, and the split is drawn where it is felt: a fixed strip at the
 * rail's foot, reachable without scrolling past eighty pods to find it.
 */
const APP_ROWS: NavItem[] = [
  {
    labelKey: "settings",
    path: "/settings",
    icon: Settings,
    section: "/settings",
    updateBadge: true,
  },
];

export function Sidebar() {
  const isConnected = useClusterStore((s) => s.isConnected);
  const { data } = useScopedOverview();

  // The overview query keeps its last answer as placeholder data across the
  // key change a disconnect causes, which is right while switching clusters
  // and wrong once there is no cluster: the rail went on printing the counts
  // of the cluster the reader had just left. The status bar has always said
  // "not connected" here; the rail now agrees rather than inventing numbers.
  const overview = isConnected ? data : undefined;

  return (
    <aside className="flex w-52 flex-col overflow-hidden border-r border-hair">
      <ClusterRow />
      <nav className="flex-1 overflow-y-auto scrollbar-thin px-1.5 pb-2.5 pt-1">
        {GROUPS.map((group, index) => (
          <div key={group.caption ?? `ungrouped-${index}`}>
            {group.caption && (
              <GroupCaption>
                <T section="nav" k={group.caption} />
              </GroupCaption>
            )}
            {group.items.map((item) => (
              <NavRow key={item.path} item={item} overview={overview} />
            ))}
          </div>
        ))}
        <IntegrationsGroup />
      </nav>
      {/* The app's own strip, outside the scroll: the rows above are the
          cluster's and travel with it; these stay put on every screen. */}
      <div className="border-t border-hair px-1.5 pb-2.5">
        <GroupCaption>
          <T section="nav" k="app" />
        </GroupCaption>
        {APP_ROWS.map((item) => (
          <NavRow key={item.path} item={item} overview={overview} />
        ))}
      </div>
    </aside>
  );
}

function GroupCaption({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase leading-[13px] tracking-[0.07em] text-fg-fnt">
      {children}
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
 * `NavLink` light all of them at once.
 */
function IntegrationsGroup() {
  const { pathname, search } = useLocation();
  const { pages, pending } = useIntegrationPages();
  const context = useClusterStore((state) => state.currentContext);
  const saved = useClusterForwardStore((state) => state.forwards);
  const queryClient = useQueryClient();
  const [waking, setWaking] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);

  const vendor = new URLSearchParams(search).get("vendor");

  // The catalog is the category's own door — the inventory of everything
  // the app knows, installed or not — so the group always draws, even on a
  // cluster with nothing detected: "this cluster has none of these" is an
  // answer that page owns, not a reason to hide the way to it.
  const catalog = (
    <NavRow
      item={{ label: "All integrations", path: "/integrations", icon: Plug }}
      overview={undefined}
      value={null}
      active={pathname === "/integrations" && vendor === null}
    />
  );

  // Detection still running is not "no integrations" — the rail holds the
  // group's shape instead of popping it in a second later.
  if (pages.length === 0 && pending) {
    return (
      <div>
        <GroupCaption>
          <T section="nav" k="integrations" />
        </GroupCaption>
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
        <GroupCaption>
          <T section="nav" k="integrations" />
        </GroupCaption>
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
      .catch((error: unknown) =>
        setFailed(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setWaking(null));
  };

  return (
    <div>
      <GroupCaption>
        <T section="nav" k="integrations" />
      </GroupCaption>
      {pages.map((page) => (
        <NavRow
          key={page.path}
          item={{ label: page.name, path: page.path, icon: page.icon }}
          overview={undefined}
          value={page.count}
          // A tunnel that is down is not a count and not a fault: it is a
          // thing this row can do something about, and says so.
          note={
            page.asleep
              ? waking === page.id
                ? "connecting…"
                : "asleep"
              : undefined
          }
          onPress={page.asleep ? () => press(page.id) : undefined}
          active={
            page.own
              ? undefined
              : pathname === "/integrations" && vendor === page.id
          }
        />
      ))}
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
  const currentContext = useClusterStore((s) => s.currentContext);
  const alias = useClusterMark(currentContext).alias?.trim();
  const isConnected = useClusterStore((s) => s.isConnected);
  const isLoading = useClusterStore((s) => s.isLoading);
  const isAuthenticating = useClusterStore((s) => s.isAuthenticating);

  const connecting = isLoading || isAuthenticating;

  const body = (
    <>
      <ProviderMark
        provider={detectProvider(currentContext ?? "")}
        className="h-[15px] w-[15px] flex-none"
        style={{ color: "var(--cluster)" }}
      />
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-[12px] font-semibold leading-[15px] text-fg">
          {alias ?? currentContext ?? "no cluster"}
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
        aria-label={
          isConnected ? "connected" : connecting ? "connecting" : "disconnected"
        }
        className={cn(
          "ml-auto h-[7px] w-[7px] flex-none rounded-full",
          !isConnected && (connecting ? "bg-warn" : "bg-fg-fnt")
        )}
        style={
          isConnected
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

  const row =
    "flex h-[38px] w-full flex-none items-center gap-2 px-2.5 text-left";

  // Nothing to configure about a cluster there is none of, and a menu that
  // renamed `null` would write a mark under an empty key.
  if (!currentContext) return <div className={row}>{body}</div>;

  return (
    <ClusterMenu context={currentContext} openOnClick>
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={`${alias ?? currentContext} — rename or recolour`}
        className={cn(
          row,
          "transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-hidden"
        )}
      >
        {body}
      </button>
    </ClusterMenu>
  );
}

function NavRow({
  item,
  overview,
  value,
  note,
  onPress,
  active,
}: {
  item: NavItem;
  overview: ClusterOverview | undefined;
  /** A count this row carries itself, for a row the overview knows nothing about. */
  value?: number | null;
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
  const { pathname } = useLocation();
  const updateAvailable = useUpdaterStore((state) => state.available);
  const badge = item.updateBadge === true && updateAvailable;

  // The dot is a deep link, not a decoration. It says an update is waiting,
  // so it goes where the update is; `/settings` redirects to Appearance,
  // which is the one pane that says nothing about updates.
  const to = badge ? UPDATES_PATH : item.path;

  // ...and pointing at one pane must not stop the other four lighting the
  // row, which is what the href alone would now decide.
  const ownsRoute =
    item.section !== undefined && pathname.startsWith(item.section);

  const isOpen = (routerSaysActive: boolean) =>
    (active ?? routerSaysActive) || ownsRoute;

  return (
    <NavLink
      to={to}
      end={item.path === "/"}
      onClick={onPress}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-[9px] rounded-[5px] px-2 py-1 text-[12px] leading-[15px] text-fg-mid transition-colors hover:bg-hover",
          isOpen(isActive) && "bg-sel font-medium text-fg"
        )
      }
    >
      {({ isActive }) => (
        <>
          <div className="relative flex-none">
            <item.icon
              className={cn(
                // The icon sits a step below the label in contrast — it aids
                // recognition without competing with it. Only the active row
                // lifts it, which is what marks the row rather than the fill.
                "h-3.5 w-3.5 text-fg-fnt transition-colors group-hover:text-fg-mut",
                isOpen(isActive) && "text-info group-hover:text-info"
              )}
            />
            {badge && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-err" />
            )}
          </div>
          {item.labelKey ? <T section="nav" k={item.labelKey} /> : item.label}
          {note !== undefined ? (
            <span className="ml-auto text-[10px] text-fg-fnt">{note}</span>
          ) : value === undefined ? (
            <NavCount item={item} overview={overview} />
          ) : (
            value !== null && (
              <span className="ml-auto text-[11px] text-fg-fnt">{value}</span>
            )
          )}
        </>
      )}
    </NavLink>
  );
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
  overview,
}: {
  item: NavItem;
  overview: ClusterOverview | undefined;
}) {
  if (!overview) return null;

  if (item.path === "/") {
    // Uncapped: the backend truncates its ranked list, and a headline that
    // shrank when things got worse would be the one number nobody can use.
    const problems = overview.problems.length + overview.problemsTruncated;
    if (problems === 0) return null;
    return <span className="ml-auto text-[11px] text-err">{problems}</span>;
  }

  const count = item.count && overview.counts[item.count];
  if (count == null) return null;
  return <span className="ml-auto text-[11px] text-fg-fnt">{count}</span>;
}
