/**
 * Scope tabs.
 *
 * A tab is a browser tab: a route — pathname *and* query string, so an open
 * peek comes back with it — plus the scope that route is read under, one
 * cluster and one namespace. Switching tabs therefore takes the reader
 * somewhere instead of re-filtering the screen they were already on.
 *
 * The backend holds a single live connection, so only the active tab is
 * live. The others are parked records, not mounted React trees: there is
 * one router outlet and it belongs to the active tab, which is what keeps
 * a parked tab from holding watches or queries.
 *
 * The active tab owns neither its scope nor its route — both mirror the
 * thing that actually holds them, `clusterStore` and the router. Storing a
 * second copy would give two sources of truth that drift the moment
 * anything else (the command palette, a restored preference, any `<Link>`)
 * moves the app. `recordHref` is the router's only writer, and
 * `pendingHref` is the one direction that runs the other way: an
 * activation asks for a route and the router bridge in `useScopeTabs`
 * delivers it.
 *
 * @module stores/scopeTabStore
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getDisplayPlural, isResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "./clusterStore";

/**
 * Where a new tab starts. The overview is the app's home page and the one
 * screen that means something at any scope, including no namespace and no
 * cluster at all.
 */
const HOME = "/";

export interface ScopeTab {
  id: string;
  /** Parked scope. Ignored while this tab is the active one. */
  context: string | null;
  namespace: string;
  /** Route as `pathname + search`; mirrored from the router while active. */
  href: string;
  /** The kubeconfig no longer lists `context`. Owned by `reconcileContexts`. */
  missing: boolean;
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

  openTab: (options?: {
    href?: string;
    context?: string;
    namespace?: string;
    /** Open behind the current tab, the way a browser opens a middle-click. */
    background?: boolean;
  }) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  /** Step through the strip, wrapping at both ends. */
  activateRelative: (delta: number) => Promise<void>;
  /** Activate by position; negative counts from the end, as `Array.at` does. */
  activateIndex: (index: number) => Promise<void>;
  /** Re-apply the active tab's scope, e.g. once the kubeconfig has loaded. */
  resumeActive: () => Promise<void>;
  recordHref: (href: string) => void;
  routeSettled: () => void;
  reconcileContexts: (names: string[]) => void;
}

let nextId = 0;
const makeId = () => `scope-${++nextId}`;

function makeTab(init: Partial<ScopeTab> = {}): ScopeTab {
  return {
    id: makeId(),
    context: null,
    namespace: "",
    href: HOME,
    missing: false,
    ...init,
  };
}

/** Park the live scope on the tab that currently owns it. */
function parkActive(tabs: ScopeTab[], activeId: string): ScopeTab[] {
  const { currentContext, currentNamespace } = useClusterStore.getState();
  return tabs.map((tab) =>
    // A tab whose cluster is gone never went live, so there is nothing on it
    // to park — and parking would overwrite the context name that is the
    // only record of what the tab was pointed at.
    tab.id === activeId && !tab.missing
      ? { ...tab, context: currentContext, namespace: currentNamespace }
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
    await cluster.connect(tab.context);
  }
  if (useClusterStore.getState().currentNamespace !== tab.namespace) {
    await useClusterStore.getState().switchNamespace(tab.namespace);
  }
}

const initialTab = makeTab();

export const useScopeTabStore = create<ScopeTabState>()(
  persist(
    (set, get) => ({
      tabs: [initialTab],
      activeId: initialTab.id,
      pendingHref: null,

      openTab: async ({ href, context, namespace, background } = {}) => {
        const live = useClusterStore.getState();
        // A new tab inherits the cluster the reader is already looking at:
        // the common reason to open one is a second view of the same
        // cluster, and inheriting makes the shortcut instant instead of
        // routing through a connect and possibly an auth prompt.
        const tab = makeTab({
          context: context ?? live.currentContext,
          namespace: namespace ?? live.currentNamespace,
          href: href ?? HOME,
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

      activateTab: async (id: string) => {
        const { tabs, activeId } = get();
        if (id === activeId) return;
        const target = tabs.find((tab) => tab.id === id);
        if (!target) return;
        set({
          tabs: parkActive(tabs, activeId),
          activeId: id,
          pendingHref: target.href,
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
        const { tabs, activeId } = get();
        const active = tabs.find((tab) => tab.id === activeId);
        if (active) await applyScope(active);
      },

      closeTab: async (id: string) => {
        const { tabs, activeId } = get();
        // The strip is the only way back to a scope, so it never empties: a
        // window with no tabs has no scope at all and nothing to put in its
        // chrome. Closing the last one resets it to an empty scope on the
        // overview instead, which is the state a fresh install boots into.
        if (tabs.length < 2) {
          set({
            tabs: [makeTab({ id: tabs[0].id })],
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

      routeSettled: () => set({ pendingHref: null }),

      reconcileContexts: (names: string[]) =>
        set((state) => {
          // An empty list is a kubeconfig that failed to load, not one that
          // lost every cluster; flagging every tab on it would be a lie.
          if (names.length === 0) return state;
          const known = new Set(names);
          const tabs = state.tabs.map((tab) => {
            const missing = !!tab.context && !known.has(tab.context);
            return missing === tab.missing ? tab : { ...tab, missing };
          });
          return tabs.every((tab, i) => tab === state.tabs[i])
            ? state
            : { tabs };
        }),
    }),
    {
      name: "scope-tabs",
      version: 1,
      // The route and the parked scope are the workspace; `pendingHref` is
      // one activation's in-flight state and means nothing next launch.
      partialize: (state) => ({ tabs: state.tabs, activeId: state.activeId }),
      // Version 1 is the first payload that carries routes at all. Anything
      // older is a bare scope list, so the tabs survive and land on the
      // overview rather than being thrown away with the workspace.
      migrate: (persisted) => {
        const state = persisted as
          | { tabs?: Partial<ScopeTab>[]; activeId?: string }
          | undefined;
        const tabs = (state?.tabs ?? [])
          .filter((tab) => typeof tab?.id === "string")
          .map((tab) => ({
            id: tab.id as string,
            context: typeof tab.context === "string" ? tab.context : null,
            namespace: typeof tab.namespace === "string" ? tab.namespace : "",
            href:
              typeof tab.href === "string" && tab.href.startsWith("/")
                ? tab.href
                : HOME,
            missing: false,
          }));
        return { tabs, activeId: state?.activeId } as ScopeTabState;
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!state.tabs?.length) state.tabs = [makeTab()];
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
        // reports from being recorded over the restored one.
        state.pendingHref = active.href;
      },
    }
  )
);

/**
 * What the tab's route is called.
 *
 * A detail route is named by the object it shows, not by its kind — the
 * reader opened `api-7f9`, not "pods" — and an open peek wins over the list
 * behind it, because the peek is what is on screen.
 */
export function tabRouteLabel(href: string): string {
  const [path, query = ""] = href.split("?");
  const peek = new URLSearchParams(query).get("peek");
  const peeked = peek?.split("/").filter(Boolean).at(-1);
  if (peeked) return peeked;

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "overview";
  // A known plural in the last position is a list page — `/workloads/pods`
  // as much as `/nodes`. Anything else is the object the route shows.
  const last = segments.at(-1) as string;
  return isResourceType(last) ? getDisplayPlural(last).toLowerCase() : last;
}

/**
 * The whole tab in one line, for a tooltip or an accessible name.
 *
 * A renamed cluster is named twice — what the tab reads, and what it
 * actually is. Dropping either would leave a reader who cannot see the
 * strip with a name that matches nothing they can act on, or a name that
 * matches nothing they can see.
 */
export function tabTitle(tab: ScopeTab, alias?: string): string {
  const name = tab.context ?? "no cluster";
  const cluster = alias ? `${alias} (${name})` : name;
  const scope = tab.missing ? `${cluster} (missing)` : cluster;
  return `${scope} · ${tab.namespace || "all namespaces"} · ${tabRouteLabel(tab.href)}`;
}
