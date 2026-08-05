/**
 * Scope tabs.
 *
 * A tab is a scope — one cluster plus the namespace being looked at.
 * The backend holds a single live connection, so only the active tab's
 * scope is live: the others are parked scopes that are re-applied when
 * their tab is activated. The active tab therefore does not store its
 * own context/namespace, it mirrors `clusterStore`; storing both would
 * give two sources of truth that drift the moment anything else (the
 * command palette, a restored preference) switches the cluster.
 *
 * @module stores/scopeTabStore
 */

import { create } from "zustand";

import { useClusterStore } from "./clusterStore";

export interface ScopeTab {
  id: string;
  /** Parked scope. Ignored while this tab is the active one. */
  context: string | null;
  namespace: string;
}

interface ScopeTabState {
  tabs: ScopeTab[];
  activeId: string;

  /** Open a new tab on `context`, scoped to all namespaces, and go to it. */
  openTab: (context: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => Promise<void>;
}

let nextId = 1;
const makeId = () => `scope-${nextId++}`;

const firstTab: ScopeTab = { id: makeId(), context: null, namespace: "" };

/** Park the live scope on the tab that currently owns it. */
function parkActive(tabs: ScopeTab[], activeId: string): ScopeTab[] {
  const { currentContext, currentNamespace } = useClusterStore.getState();
  return tabs.map((tab) =>
    tab.id === activeId
      ? { ...tab, context: currentContext, namespace: currentNamespace }
      : tab
  );
}

async function applyScope(tab: ScopeTab) {
  const cluster = useClusterStore.getState();
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

export const useScopeTabStore = create<ScopeTabState>((set, get) => ({
  tabs: [firstTab],
  activeId: firstTab.id,

  openTab: async (context: string) => {
    const tab: ScopeTab = { id: makeId(), context, namespace: "" };
    set((state) => ({
      tabs: [...parkActive(state.tabs, state.activeId), tab],
      activeId: tab.id,
    }));
    await applyScope(tab);
  },

  activateTab: async (id: string) => {
    const { tabs, activeId } = get();
    if (id === activeId) return;
    const target = tabs.find((tab) => tab.id === id);
    if (!target) return;
    set({ tabs: parkActive(tabs, activeId), activeId: id });
    await applyScope(target);
  },

  closeTab: async (id: string) => {
    const { tabs, activeId } = get();
    // The strip is the only way back to a scope, so it never empties:
    // closing the last tab drops the connection and leaves an empty
    // scope to pick a cluster in, rather than a window with no chrome.
    if (tabs.length < 2) {
      set({ tabs: [{ id: tabs[0].id, context: null, namespace: "" }] });
      // Disconnect first: switchNamespace only writes a preference while
      // a context is set, and the cleared scope must not save one.
      await useClusterStore.getState().disconnect();
      await useClusterStore.getState().switchNamespace("");
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    const remaining = parkActive(tabs, activeId).filter((tab) => tab.id !== id);
    if (id !== activeId) {
      set({ tabs: remaining });
      return;
    }
    const next = remaining[Math.min(index, remaining.length - 1)];
    set({ tabs: remaining, activeId: next.id });
    await applyScope(next);
  },
}));
