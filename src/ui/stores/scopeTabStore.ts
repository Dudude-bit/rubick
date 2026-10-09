/**
 * Scope tabs.
 *
 * A tab is a browser tab: a route — pathname *and* query string, so an open
 * peek comes back with it — plus the scope that route is read under, one
 * cluster and one namespace.
 *
 * The backend holds a single live connection, so only the active tab is live.
 * The others are parked records, not mounted React trees: there is one router
 * outlet and it belongs to the active tab, which is what keeps a parked tab
 * from holding watches or queries.
 *
 * The active tab owns neither its scope nor its route — both mirror the thing
 * that actually holds them, `clusterStore` and the router. A second copy would
 * be a second source of truth, drifting the moment anything else (the command
 * palette, a restored preference, any `<Link>`) moves the app. `recordHref` is
 * the router's only writer; `pendingHref` is the one direction that runs the
 * other way: an activation asks for a route and the router bridge in
 * `useScopeTabs` delivers it.
 *
 * @module stores/scopeTabStore
 */

import type { T } from "@/i18n/useT";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  clampScope,
  decodeScope,
  sameScope,
  wireNamespace,
} from "@/lib/namespace-scope";
import { ACCESS_KINDS, segmentOf } from "@/lib/access-kinds";
import { clusterOf, retargetHref } from "@/lib/links";
import {
  RESOURCE_REGISTRY,
  getDisplayPlural,
  isResourceType,
} from "@/lib/resource-registry";
import { useClusterStore } from "./clusterStore";

/** The front door: no cluster yet, and a tab's address before it has one. */
const HOME = "/";

/**
 * Where a tab starts and where closing the last one sends it: the overview,
 * the one screen that means something at any scope, in the tab's cluster.
 */
const homeOf = (context: string | null): string =>
  context ? retargetHref(HOME, context) : HOME;

export interface ScopeTab {
  id: string;
  /** Parked scope. Ignored while this tab is the active one. */
  context: string | null;
  /**
   * The parked scope's wire value, and the only field a build without
   * multi-namespace scopes reads. It is written for that build's benefit —
   * {@link scope} is what this one restores. See `lib/namespace-scope.ts`.
   */
  namespace: string;
  /**
   * The parked selection, and the truth wherever it is set. A tab persisted
   * by a build older than this field has only `namespace`, which is where
   * {@link tabScope} reads it from instead.
   */
  scope?: string[];
  /**
   * Route as `pathname + search`, which names the cluster it is in;
   * mirrored from the router while active.
   */
  href: string;
  /** The kubeconfig no longer lists `context`. Owned by `reconcileContexts`. */
  missing: boolean;
  /**
   * Where Back goes, newest last: this tab's own earlier routes. The window
   * has one history for every tab, and Back in it walked into the others.
   */
  back?: string[];
}

interface ScopeTabState {
  tabs: ScopeTab[];
  activeId: string;
  /**
   * The route an activation is waiting on, or null when the window is
   * where the active tab says it should be. Non-null means the reader is
   * mid-switch: the outlet is held shut until it clears, so a page never
   * renders one tab's route under another tab's scope.
   */
  pendingHref: string | null;
  /** The pending route takes the place of the one on screen, as Back does. */
  pendingReplace: boolean;
  /**
   * The window was launched with a link, which owns the route and scope the
   * restored session would have put back. The tabs are still restored.
   */
  linked: boolean;

  openTab: (options?: {
    href?: string;
    context?: string;
    namespace?: string;
    /** Open behind the current tab, the way a browser opens a middle-click. */
    background?: boolean;
  }) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  /** `href`, when given, is where the tab opens instead of where it was left. */
  activateTab: (id: string, href?: string) => Promise<void>;
  /** Step through the strip, wrapping at both ends. */
  activateRelative: (delta: number) => Promise<void>;
  /** Activate by position; negative counts from the end, as `Array.at` does. */
  activateIndex: (index: number) => Promise<void>;
  /** Re-apply the active tab's scope, e.g. once the kubeconfig has loaded. */
  resumeActive: () => Promise<void>;
  /** The link the window was launched with takes the active tab, not the route restored for it. */
  yieldToLink: (link: { context: string; path: string }) => void;
  recordHref: (href: string) => void;
  /** The router went from one route to a new one in the active tab. */
  pushed: (from: string, to: string) => void;
  /** Back in the active tab, to its own last route and never another tab's. */
  goBack: () => void;
  /** Let go of a route that belongs to the cluster just left. */
  retargetAfterSwitch: (connected: string | null) => void;
  /** The window connected while the active tab named a lost cluster. */
  adoptConnected: (connected: string) => void;
  routeSettled: () => void;
  reconcileContexts: (names: string[]) => void;
}

let nextId = 0;
const makeId = () => `scope-${++nextId}`;

/** As far back as a tab remembers, like a browser tab's own limit. */
const BACK_LIMIT = 50;

/** A tab as it is written to disk: its Back belongs to this session. */
const withoutHistory = ({ back: _back, ...tab }: ScopeTab): ScopeTab => tab;

function makeTab(init: Partial<ScopeTab> = {}): ScopeTab {
  return {
    id: makeId(),
    context: null,
    namespace: "",
    scope: [],
    href: HOME,
    missing: false,
    ...init,
  };
}

/** Park the live scope on the tab that currently owns it. */
function parkActive(tabs: ScopeTab[], activeId: string): ScopeTab[] {
  const { currentContext, currentNamespace, namespaceScope } =
    useClusterStore.getState();
  return tabs.map((tab) =>
    // A tab whose cluster is gone never went live, so there is nothing on it
    // to park — and parking would overwrite the context name that is the
    // only record of what the tab was pointed at.
    tab.id === activeId && !tab.missing
      ? {
          ...tab,
          context: currentContext,
          namespace: currentNamespace,
          scope: namespaceScope,
        }
      : tab
  );
}

async function applyScope(tab: ScopeTab) {
  const cluster = useClusterStore.getState();
  // Leaving the previous cluster connected under this tab's name would put
  // one cluster's numbers beside another cluster's label, which is the
  // single mistake this strip exists to prevent.
  if (tab.missing) {
    if (cluster.currentContext) await cluster.disconnect();
    return;
  }
  if (!tab.context) return;
  if (tab.context !== cluster.currentContext) {
    // connect() clears the namespace when the context changes, so the
    // tab's namespace has to be re-applied after it resolves.
    //
    // `keepRoute`: this tab is already delivering a route of its own, and
    // the `pendingHref` guard alone cannot protect it — the router can
    // settle that route before this connect resolves.
    await cluster.connect(tab.context, { keepRoute: true });
  }
  const live = useClusterStore.getState();
  const scope = tabScope(tab);
  if (!sameScope(live.namespaceScope, scope)) {
    await live.setNamespaceScope(scope);
  }
}

/**
 * The selection a tab is parked on, wherever that tab recorded it.
 *
 * `scope` is younger than `namespace`, so a payload from any earlier build —
 * a single namespace, or the joined list this feature briefly stored — has
 * only the older field, and it is read back out of that one.
 *
 * Both fields present but disagreeing is a third case, and it is the one a
 * downgrade leaves behind: a build without this feature reads and writes
 * `namespace`, cannot touch `scope`, and so parks a pair this build never
 * writes — `namespace` is always {@link wireNamespace} of the selection
 * beside it. The disagreement is evidence of which record is younger, and
 * taking it is what keeps the reader's last choice from being silently
 * discarded on the way back up.
 */
export function tabScope(tab: ScopeTab): string[] {
  const parked = tab.scope;
  if (!parked) return decodeScope(tab.namespace);
  if (tab.namespace !== wireNamespace(parked))
    return decodeScope(tab.namespace);
  return parked;
}

/**
 * A tab as this build understands it. Applied once, on the way in from disk,
 * so that what the strip draws is what activating the tab would apply — a tab
 * restored from a build with a larger ceiling must not name namespaces this
 * one is not going to read.
 */
function normalizeTab(tab: ScopeTab): ScopeTab {
  const scope = clampScope(tabScope(tab));
  return { ...tab, scope, namespace: wireNamespace(scope) };
}

const initialTab = makeTab();

export const useScopeTabStore = create<ScopeTabState>()(
  persist(
    (set, get) => ({
      tabs: [initialTab],
      activeId: initialTab.id,
      pendingHref: null,
      pendingReplace: false,
      linked: false,

      openTab: async ({ href, context, namespace, background } = {}) => {
        const live = useClusterStore.getState();
        // A tab opened *at* something — a link gesture on an object — lands
        // on that object's namespace alone; one opened from the strip
        // inherits the whole selection the reader is already reading under.
        const scope =
          namespace === undefined
            ? live.namespaceScope
            : namespace
              ? [namespace]
              : [];
        // A new tab inherits the cluster the reader is already looking at:
        // the common reason to open one is a second view of the same
        // cluster, and inheriting makes the shortcut instant instead of
        // routing through a connect and possibly an auth prompt.
        const tabContext = context ?? live.currentContext;
        const tab = makeTab({
          context: tabContext,
          namespace: wireNamespace(scope),
          scope,
          href: href ?? homeOf(tabContext),
        });
        if (background) {
          set((state) => ({ tabs: [...state.tabs, tab] }));
          return;
        }
        set((state) => ({
          tabs: [...parkActive(state.tabs, state.activeId), tab],
          activeId: tab.id,
          pendingHref: tab.href,
        }));
        await applyScope(tab);
      },

      activateTab: async (id: string, href?: string) => {
        const { tabs, activeId } = get();
        if (id === activeId) return;
        const target = tabs.find((tab) => tab.id === id);
        if (!target) return;
        const to = href ?? target.href;
        set({
          tabs: parkActive(tabs, activeId).map((tab) =>
            tab.id === id ? { ...tab, href: to } : tab
          ),
          activeId: id,
          pendingHref: to,
        });
        await applyScope(target);
      },

      activateRelative: async (delta: number) => {
        const { tabs, activeId } = get();
        if (tabs.length < 2) return;
        const index = tabs.findIndex((tab) => tab.id === activeId);
        const next = (index + delta + tabs.length) % tabs.length;
        await get().activateTab(tabs[next].id);
      },

      activateIndex: async (index: number) => {
        const target = get().tabs.at(index);
        if (target) await get().activateTab(target.id);
      },

      resumeActive: async () => {
        const { tabs, activeId, linked } = get();
        // The link's route connects its own cluster and narrows its own scope.
        if (linked) return;
        const active = tabs.find((tab) => tab.id === activeId);
        if (active) await applyScope(active);
      },

      yieldToLink: ({ context, path }) =>
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === state.activeId
              ? { ...tab, context, href: path, missing: false }
              : tab
          ),
          pendingHref: null,
          pendingReplace: false,
          linked: true,
        })),

      closeTab: async (id: string) => {
        const { tabs, activeId } = get();
        // The strip never empties — a window with no tabs has no scope. So
        // closing the last one has two meanings, told apart by where it sits:
        // on a page, the ✕ reads as "close this view" like the peek ✕ and the
        // detail back arrow, and returns to the overview keeping the cluster
        // and namespace; already on the overview, it is the fresh-install
        // reset (disconnect, empty scope) and the one way back to the picker.
        if (tabs.length < 2) {
          const only = tabs[0];
          // Snapshot the live scope (the reader may have changed the
          // namespace via the popover since this tab went live).
          const parked = parkActive(tabs, only.id)[0];
          const home = homeOf(parked.context);
          if (only.href !== home && !only.missing) {
            // Keep the scope and send the view home, with no disconnect and
            // no cleared namespace.
            set({ tabs: [{ ...parked, href: home }], pendingHref: home });
            return;
          }
          set({
            tabs: [makeTab({ id: only.id })],
            pendingHref: HOME,
          });
          // Disconnect first: switchNamespace only writes a preference while
          // a context is set, and the cleared scope must not save one.
          await useClusterStore.getState().disconnect();
          await useClusterStore.getState().switchNamespace("");
          return;
        }
        const index = tabs.findIndex((tab) => tab.id === id);
        if (index === -1) return;

        const remaining = parkActive(tabs, activeId).filter(
          (tab) => tab.id !== id
        );
        if (id !== activeId) {
          set({ tabs: remaining });
          return;
        }
        // The tab that slid into this one's place, or the new last tab —
        // the browser rule, and the one that keeps the reader's eye still.
        const next = remaining[Math.min(index, remaining.length - 1)];
        set({ tabs: remaining, activeId: next.id, pendingHref: next.href });
        await applyScope(next);
      },

      retargetAfterSwitch: (connected: string | null) => {
        const { tabs, activeId, pendingHref } = get();
        // An activation is already delivering a route of its own; this is
        // only for a cluster that changed under a tab standing still.
        if (pendingHref !== null) return;
        const active = tabs.find((tab) => tab.id === activeId);
        if (!active || connected === null) return;
        // The address names the cluster, so one already in the cluster that
        // connected is what connected it, and there is nothing to let go of.
        if (clusterOf(active.href) === connected) return;
        // Otherwise the connection moved under a standing address, which
        // follows it: a list stays a list, an object gives way to its list.
        const moved = retargetHref(active.href, connected);
        set({
          tabs: tabs.map((tab) =>
            tab.id === activeId ? { ...tab, href: moved } : tab
          ),
          pendingHref: moved,
        });
      },

      // Picking a cluster on a lost tab's front door connects the window;
      // the tab has to become that cluster's, or it keeps the lost name over
      // another cluster's rows.
      adoptConnected: (connected: string) =>
        set((state) => {
          const active = state.tabs.find((tab) => tab.id === state.activeId);
          if (!active?.missing) return state;
          // The scope `connect` restored for that cluster, not an empty one
          // that the next launch would apply over it.
          const { currentNamespace, namespaceScope } =
            useClusterStore.getState();
          return {
            tabs: state.tabs.map((tab) =>
              tab.id === state.activeId
                ? {
                    ...tab,
                    missing: false,
                    context: connected,
                    namespace: currentNamespace,
                    scope: namespaceScope,
                  }
                : tab
            ),
          };
        }),

      recordHref: (href: string) =>
        set((state) => {
          // An activation owns the route until it lands; recording here
          // would write the route the reader is leaving onto the tab they
          // are arriving at.
          if (state.pendingHref !== null) return state;
          const active = state.tabs.find((tab) => tab.id === state.activeId);
          if (!active || active.href === href) return state;
          return {
            tabs: state.tabs.map((tab) =>
              tab.id === state.activeId ? { ...tab, href } : tab
            ),
          };
        }),

      pushed: (from: string, to: string) =>
        set((state) => {
          if (state.pendingHref !== null || from === to) return state;
          return {
            tabs: state.tabs.map((tab) =>
              tab.id === state.activeId
                ? {
                    ...tab,
                    back: [...(tab.back ?? []), from].slice(-BACK_LIMIT),
                  }
                : tab
            ),
          };
        }),

      goBack: () =>
        set((state) => {
          if (state.pendingHref !== null) return state;
          const active = state.tabs.find((tab) => tab.id === state.activeId);
          if (!active) return state;
          const back = active.back ?? [];
          // Nothing behind it: the tab stays where it is, as a browser tab does.
          const to = back.at(-1) ?? active.href;
          return {
            tabs: state.tabs.map((tab) =>
              tab.id === active.id
                ? { ...tab, href: to, back: back.slice(0, -1) }
                : tab
            ),
            pendingHref: to,
            pendingReplace: true,
          };
        }),

      routeSettled: () => set({ pendingHref: null, pendingReplace: false }),

      reconcileContexts: (names: string[]) =>
        set((state) => {
          // An empty list is a kubeconfig that failed to load, not one that
          // lost every cluster; flagging every tab on it would be a lie.
          if (names.length === 0) return state;
          const known = new Set(names);
          let goTo: string | null = null;
          const tabs = state.tabs.map((tab) => {
            const missing = !!tab.context && !known.has(tab.context);
            // An object in a cluster this kubeconfig does not have is a page
            // nothing can answer. From the state, not the change, so a tab
            // already flagged is not left holding the dead route.
            const href = missing
              ? (listBehind(tab.href) ?? tab.href)
              : tab.href;
            if (missing === tab.missing && href === tab.href) return tab;
            // Rewriting the record takes nobody anywhere, and `recordHref`
            // would write the dead route straight back.
            if (href !== tab.href && tab.id === state.activeId) goTo = href;
            return { ...tab, missing, href };
          });
          if (tabs.every((tab, i) => tab === state.tabs[i])) return state;
          return goTo === null ? { tabs } : { tabs, pendingHref: goTo };
        }),
    }),
    {
      name: "scope-tabs",
      version: 2,
      // The route and the parked scope are the workspace; `pendingHref` is
      // one activation's in-flight state and means nothing next launch.
      partialize: (state) => ({
        tabs: state.tabs.map(withoutHistory),
        activeId: state.activeId,
      }),
      // Version 1 is the first payload that carries routes at all, and
      // version 2 the first whose routes name their cluster. Anything older
      // keeps its tabs and scopes and loses its routes: an address from
      // before `/c/<cluster>` matches nothing the app serves.
      migrate: (persisted) => {
        const state = persisted as
          | { tabs?: Partial<ScopeTab>[]; activeId?: string }
          | undefined;
        const tabs = (state?.tabs ?? [])
          .filter((tab) => typeof tab?.id === "string")
          .map((tab) =>
            normalizeTab({
              id: tab.id as string,
              context: typeof tab.context === "string" ? tab.context : null,
              namespace: typeof tab.namespace === "string" ? tab.namespace : "",
              // Left unset rather than emptied when the payload predates it:
              // an empty selection is "the whole cluster", which is not what
              // a tab parked on one namespace meant.
              scope: Array.isArray(tab.scope) ? tab.scope : undefined,
              href:
                typeof tab.href === "string" && tab.href.startsWith("/c/")
                  ? tab.href
                  : HOME,
              missing: false,
            })
          );
        return { tabs, activeId: state?.activeId } as ScopeTabState;
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!state.tabs?.length) state.tabs = [makeTab()];
        // Not only for a version bump: a payload written before `scope`
        // existed carries the same version this build writes, so the field
        // has to be recovered here rather than in `migrate`.
        state.tabs = state.tabs.map(normalizeTab).map((tab) =>
          // A tab with no route of its own opens on its cluster's overview;
          // the front door would send it to whichever cluster was last.
          tab.href === HOME ? { ...tab, href: homeOf(tab.context) } : tab
        );
        // Ids are a counter and the counter restarts at zero every launch,
        // so a fresh tab would otherwise be handed an id a restored tab
        // already holds — and React would key two tabs the same.
        for (const tab of state.tabs) {
          const n = Number(/^scope-(\d+)$/.exec(tab.id)?.[1]);
          if (Number.isFinite(n) && n > nextId) nextId = n;
        }
        const active =
          state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];
        state.activeId = active.id;
        // The window boots at "/", not where the tab was left. Asking for
        // the route here is also what stops the first location the router
        // reports from being recorded over the restored one. A tab with no
        // cluster asks for nothing: the window is already at its front door.
        state.pendingHref = active.href === HOME ? null : active.href;
      },
    }
  )
);

/**
 * What the tab's route is called.
 *
 * A detail route is named by the object it shows, not by its kind: the
 * reader opened `api-7f9`, not "pods". A peek never renames the tab; it is
 * a glance from the page, and the tab names the page. A list or page is
 * named the way the sidebar names it.
 */
export function tabRouteLabel(href: string, t: T): string {
  const [path] = href.split("?");
  const segments = path.split("/").filter(Boolean).map(decoded);
  // The cluster is said by the tab's own name, not by its route.
  const route = segments[0] === "c" ? segments.slice(2) : segments;
  // One segment is a list page, `/c/prod/pods` as much as `/c/prod/events`.
  // Anything longer is the object the route shows.
  if (route.length > 1) return route.at(-1) as string;
  if (route.length === 0) return t("nav", "overview");
  const [page] = route;
  if (isResourceType(page)) return getDisplayPlural(page);
  return (
    PAGE_NAMES[page]?.(t) ??
    [...ACCESS_KINDS, ...RESOURCE_REGISTRY].find(
      (entry) => segmentOf(entry) === page
    )?.displayPlural ??
    page
  );
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const PAGE_NAMES: Record<string, ((t: T) => string) | undefined> = {
  helm: () => "Helm",
  changes: (t) => t("nav", "changes"),
  integrations: (t) => t("nav", "integrations"),
  routes: (t) => t("nav", "routes"),
  "api-resources": (t) => t("nav", "apiResources"),
  "my-access": (t) => t("nav", "myAccess"),
};

/**
 * The list a route belongs to, for a route that names one object.
 *
 * `null` where the route names no object (a list, the overview, a vendor's
 * page) and so means the same thing in any cluster. Everything else names
 * a pod or a release that exists in the cluster it was opened in and
 * nowhere else, and switching left the reader holding its page, open and
 * unreadable (#148).
 */
export function listBehind(href: string): string | null {
  const [path, query = ""] = href.split("?");
  const list = listOf(path);
  // Over a list, dropping the peek is the whole move; over a detail page the
  // page has to go too, or the object stays with its panel merely closed.
  if (new URLSearchParams(query).get("peek")) return list ?? path;
  return list;
}

function listOf(path: string): string | null {
  const cluster = clusterOf(path);
  const [, , resource, ...rest] = path.split("/").filter(Boolean);
  if (cluster === null || rest.length === 0) return null;
  // A vendor's page is about the integration, which every cluster can have.
  if (resource === "integrations") return null;
  return retargetHref(path, cluster);
}

/**
 * The whole tab in one line, for a tooltip or an accessible name.
 *
 * A renamed cluster is named twice — what the tab reads, and what it
 * actually is. Dropping either would leave a reader who cannot see the
 * strip with a name that matches nothing they can act on, or a name that
 * matches nothing they can see.
 */
export function tabTitle(tab: ScopeTab, t: T, alias?: string): string {
  const name = tab.context ?? t("cluster", "noCluster");
  const cluster = alias ? `${alias} (${name})` : name;
  const named = tab.missing
    ? t("cluster", "nameMissingParens", { name: cluster })
    : cluster;
  const namespaces = tabScope(tab);
  return `${named} · ${
    namespaces.length === 0
      ? t("nav", "allNamespacesLower")
      : namespaces.join(", ")
  } · ${tabRouteLabel(tab.href, t)}`;
}
