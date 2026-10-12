/**
 * Cluster Store
 *
 * Manages Kubernetes cluster connection state including contexts,
 * namespaces, and connection status. Handles loading contexts from
 * kubeconfig and connecting/disconnecting from clusters.
 *
 * @module stores/clusterStore
 */

import type { ClusterInfo, ConnectionPath } from "@/generated/types";
import { translate } from "@/i18n";
import { currentLocale } from "./localeStore";
import { create } from "zustand";

import type { ContextInfo } from "@/generated/types";
import { errorToShow } from "@/lib/error-utils";
import { commands } from "@/lib/commands";
import { credentialsRestored } from "@/lib/credentials";
import { followConnections } from "@/lib/refusals";
import {
  clampScope,
  decodeScope,
  seedScope,
  wireNamespace,
} from "@/lib/namespace-scope";
import { useClusterRecencyStore } from "./clusterRecencyStore";
import { useNamespaceRecencyStore } from "./namespaceRecencyStore";

/** Cluster store state and actions */
interface ClusterState {
  contexts: ContextInfo[];
  /** The kubeconfig was read: `contexts` is its answer, not an empty start. */
  contextsKnown: boolean;
  /** Where the window was last connected, else the kubeconfig's current context. */
  lastContext: string | null;
  currentContext: string | null;
  /**
   * The one namespace to ask the API server for, or `""` for the whole
   * cluster. Derived from {@link namespaceScope} and never set on its own —
   * every command in the app takes one namespace, and this is it.
   */
  currentNamespace: string;
  /**
   * Which namespaces the window is looking at. Empty is the whole cluster,
   * and never longer than `SCOPE_LIMIT`.
   *
   * Lists are read as one cluster-wide request narrowed on this side, while
   * the aggregates are read once per namespace; see `lib/namespace-scope.ts`
   * for why that is the shape, what it costs, and where the ceiling comes
   * from.
   */
  namespaceScope: string[];
  /**
   * The selection each context was last left on.
   *
   * Switching clusters used to clear the scope, so somebody with rights to
   * two namespaces in each of six clusters reselected them every time they
   * moved. The window remembers instead, per context, and restores on the
   * way back.
   *
   * Held here as well as on disk because a switch has to happen in one
   * render — reading it back over IPC would let a beat of the new cluster
   * render under the old cluster's scope.
   */
  savedScopes: Record<string, string[]>;
  isConnected: boolean;
  /**
   * Which way the session reaches the cluster, once connected. Through a
   * proxy, kubectl holds the credentials and the app's own path failed.
   */
  connectedThrough: ConnectionPath | null;
  isLoading: boolean;
  isAuthenticating: boolean;
  error: string | null;
  pendingContext: string | null;
  errorContext: string | null;
  connectionAttemptId: number;
  /**
   * When the in-flight connect started, so the waiting screen can say how
   * long it has been waiting instead of showing a spinner that means
   * nothing. Null whenever nothing is in flight.
   */
  connectStartedAt: number | null;
  /**
   * The cluster this window was last connected to, kept across a disconnect
   * so that reconnecting somewhere else still counts as a change.
   */
  lastConnected: string | null;
  /**
   * How many times this window has landed on a different cluster than the
   * one before, so a surface holding a route from the old one can let go.
   */
  contextSwitches: number;
  /**
   * The contexts whose sessions the backend holds, as it last said. More
   * than the current one while a parked scope tab shows another cluster, or
   * while a switch has not landed and the cluster it left is the way back.
   */
  live: string[];
  /**
   * The cluster a switch left while connected to it, kept until the switch
   * lands, so one that fails leaves the reader somewhere to go back to.
   */
  wayBack: string | null;

  // Actions
  loadContexts: () => Promise<void>;
  switchContext: (context: string) => Promise<void>;
  switchNamespace: (namespace: string) => Promise<void>;
  /** Look at these namespaces, or at the whole cluster for an empty list. */
  setNamespaceScope: (namespaces: string[]) => Promise<void>;
  /**
   * `keepRoute` for a caller taking the reader somewhere itself — a deep
   * link, a tab activation. Without it the move counts as a switch and the
   * route being delivered is the one let go of.
   */
  connect: (
    context?: string,
    options?: { keepRoute?: boolean }
  ) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Disconnect every held cluster nothing on screen uses any longer. */
  release: () => Promise<void>;
}

/**
 * The clusters another surface still shows. A parked scope tab names its
 * own, and a switch in this tab must not tear that one down.
 */
let heldElsewhere: () => (string | null)[] = () => [];

export function holdClusters(held: () => (string | null)[]): void {
  heldElsewhere = held;
}

let releases = 0;

/**
 * What the window looks at after moving to `context`.
 *
 * Staying put keeps whatever is on screen. Moving restores what that cluster
 * was last left on — clearing it was the behaviour somebody with rights to
 * two namespaces in each of six clusters had to undo on every switch.
 */
function scopeFor(
  state: {
    savedScopes: Record<string, string[]>;
    namespaceScope: string[];
    contexts: ContextInfo[];
  },
  context: string,
  changed: boolean
): { namespaceScope: string[]; currentNamespace: string } {
  const scope = changed
    ? clampScope(
        state.savedScopes[context] ??
          seedScope(state.contexts.find((c) => c.name === context)?.namespace)
      )
    : state.namespaceScope;
  return { namespaceScope: scope, currentNamespace: wireNamespace(scope) };
}

/** The context a connect is in flight to. */
export const connectingTo = (s: ClusterState): string | null =>
  s.isAuthenticating ? s.pendingContext : null;

/** The context the last connect failed for, while its error stands. */
export const failedAt = (s: ClusterState): string | null =>
  s.error ? s.errorContext : null;

/** The cluster a switch left, while the backend still holds it. */
export const wayBackTo = (s: ClusterState): string | null =>
  s.wayBack !== null && s.live.includes(s.wayBack) ? s.wayBack : null;

export const useClusterStore = create<ClusterState>((set, get) => ({
  contexts: [],
  contextsKnown: false,
  lastContext: null,
  currentContext: null,
  currentNamespace: "", // Empty string means all namespaces
  namespaceScope: [],
  savedScopes: {},
  isConnected: false,
  connectedThrough: null,
  isLoading: false,
  isAuthenticating: false,
  error: null,
  pendingContext: null,
  errorContext: null,
  connectionAttemptId: 0,
  connectStartedAt: null,
  lastConnected: null,
  contextSwitches: 0,
  live: [],
  wayBack: null,

  loadContexts: async () => {
    set({ isLoading: true, error: null, errorContext: null });
    try {
      const contexts = await commands.listContexts();
      const kubeconfigCurrent = await commands.getCurrentContext();
      let lastContext: string | null = kubeconfigCurrent;

      // Restore saved cluster preferences
      try {
        const prefs = await commands.getClusterPreferences();
        if (
          prefs.lastContext &&
          contexts.some((c) => c.name === prefs.lastContext)
        ) {
          // Restore the saved scope if there is one. What is stored here is
          // one namespace or none — see `lib/namespace-scope.ts` — so this is
          // the same window every build has always reopened; `decodeScope`
          // covers the joined values earlier builds of this feature wrote.
          // Every context's selection, not only the one being reopened:
          // the first switch to another cluster has to restore without a
          // round-trip.
          const savedScopes: Record<string, string[]> = {};
          for (const [context, stored] of Object.entries(prefs.namespaces)) {
            savedScopes[context] = clampScope(decodeScope(stored));
          }
          // The list wins where there is one — `namespaces` only ever holds
          // a single namespace, so a selection of three reads as one there.
          for (const [context, stored] of Object.entries(prefs.scopes ?? {})) {
            savedScopes[context] = clampScope(stored);
          }
          set({ savedScopes });

          const scope = savedScopes[prefs.lastContext] ?? [];
          if (scope.length > 0) {
            set({
              namespaceScope: scope,
              currentNamespace: wireNamespace(scope),
            });
          }
          lastContext = prefs.lastContext;
        }
      } catch {
        // Ignore errors loading preferences - not critical
      }
      // The address decides which cluster to connect to; this only says
      // which one the front door sends the window back to.
      set({ contexts, contextsKnown: true, lastContext, isLoading: false });
    } catch (error) {
      set({
        error: errorToShow(error),
        isLoading: false,
      });
    }
  },

  switchContext: async (context: string) => {
    const previousContext = get().currentContext;
    const changed = previousContext !== null && previousContext !== context;
    set({
      currentContext: context,
      ...scopeFor(get(), context, changed),
      error: null,
      errorContext: null,
    });
  },

  switchNamespace: async (namespace: string) => {
    await get().setNamespaceScope(namespace === "" ? [] : [namespace]);
  },

  setNamespaceScope: async (namespaces: string[]) => {
    // No isLoading for a scope change: it causes flickering, and the queries
    // refetch on their own once the key changes.
    const context = get().currentContext;
    // The one place the ceiling is applied. A selection this window cannot
    // afford to answer for would leave every number on screen describing a
    // subset of the namespaces its own label names.
    const scope = clampScope([
      ...new Set(namespaces.filter((name) => name !== "")),
    ]);
    set({
      namespaceScope: scope,
      currentNamespace: wireNamespace(scope),
      error: null,
      errorContext: null,
    });
    if (context) {
      // The wire value, not the selection: this field is one opaque string
      // per context that a build without this feature reads straight into
      // `currentNamespace`. The selection itself is kept by the scope tab.
      set((state) => ({
        savedScopes: { ...state.savedScopes, [context]: scope },
      }));
      useNamespaceRecencyStore.getState().record(context, scope);
      commands
        .saveClusterPreferences(null, context, wireNamespace(scope), scope)
        .catch(() => {
          // Ignore errors saving preferences - not critical
        });
    }
  },

  connect: async (context?: string, options?: { keepRoute?: boolean }) => {
    const targetContext = context ?? get().currentContext;
    if (!targetContext) {
      set({
        error: translate(currentLocale(), "cluster", "noClusterSelected"),
        errorContext: null,
      });
      return;
    }

    // Prevent multiple concurrent connection attempts to the same context
    const before = get();
    if (before.pendingContext === targetContext) {
      return;
    }

    // A connect still in flight elsewhere is abandoned, and its sign-in
    // modal only closes on the cancel this sends.
    if (before.isAuthenticating && before.pendingContext !== null) {
      commands.disconnectCluster(before.pendingContext).catch(() => {
        // Best-effort cleanup to avoid stale auth sessions.
      });
    }
    // After a disconnect there is no previous context, and the scope left
    // behind is the last cluster's — not this one's.
    const changed = before.currentContext !== targetContext;
    const attemptId = before.connectionAttemptId + 1;
    const moving = {
      error: null,
      errorContext: null,
      pendingContext: targetContext,
      currentContext: targetContext,
      ...scopeFor(before, targetContext, changed),
      isConnected: false,
      connectedThrough: null,
      connectionAttemptId: attemptId,
      wayBack:
        before.isConnected && changed ? before.currentContext : before.wayBack,
    };

    const landed = (info: ClusterInfo) => {
      const connectedContext = info.context || targetContext;
      // On the way in, not on the attempt: a failed connect left the reader
      // where they were.
      const arrived =
        !options?.keepRoute &&
        get().lastConnected !== null &&
        get().lastConnected !== connectedContext;
      set({
        lastConnected: connectedContext,
        contextSwitches: get().contextSwitches + (arrived ? 1 : 0),
        currentContext: connectedContext,
        isConnected: true,
        connectedThrough: info.connected_through,
        isLoading: false,
        isAuthenticating: false,
        pendingContext: null,
        connectStartedAt: null,
        wayBack: null,
        live: [...new Set([...get().live, connectedContext])],
      });
      // Only a connection that landed counts as "used": ordering the
      // front door by clusters the reader failed to reach would put the
      // broken ones on top.
      useClusterRecencyStore.getState().recordUse(connectedContext);
      // Save selected cluster on successful connection
      commands
        .saveClusterPreferences(connectedContext, null, null, null)
        .catch(() => {
          // Ignore errors saving preferences - not critical
        });
      void get().release();
    };

    // A cluster the backend still holds comes back as it was left: no
    // sign-in, no probe, no waiting screen.
    if (changed && before.live.includes(targetContext)) {
      set({
        ...moving,
        isLoading: false,
        isAuthenticating: false,
        connectStartedAt: null,
      });
      const info = await commands.focusCluster(targetContext).catch(() => null);
      if (get().connectionAttemptId !== attemptId) return;
      if (info) {
        landed(info);
        return;
      }
    }

    set({
      ...moving,
      isLoading: true,
      isAuthenticating: true,
      connectStartedAt: Date.now(),
      live: get().live.filter((name) => name !== targetContext),
    });
    try {
      const info = await commands.connectCluster(targetContext);
      if (get().connectionAttemptId !== attemptId) {
        // Landed after the reader moved on, so nothing on screen uses it.
        void get().release();
        return;
      }
      landed(info);
      // A connect that landed is a session the cluster accepts, and it is
      // the only proof that lifts the refusal banner: "Sign in again"
      // reconnects to the same context, so the context-change clearing in
      // useExpiredCredentials never fires for exactly the button built to
      // recover from it.
      credentialsRestored();
    } catch (error) {
      if (get().connectionAttemptId !== attemptId) {
        return;
      }
      set({
        // Every reader of this field puts it on screen.
        error: errorToShow(error),
        errorContext: targetContext,
        isLoading: false,
        isAuthenticating: false,
        isConnected: false,
        connectedThrough: null,
        pendingContext: null,
        connectStartedAt: null,
      });
      void get().release();
    }
  },

  disconnect: async () => {
    const { pendingContext, isAuthenticating } = get();
    set({
      isConnected: false,
      connectedThrough: null,
      currentContext: null,
      // Leaving a cluster on purpose: the front door must not send the
      // window straight back to it.
      lastContext: null,
      pendingContext: null,
      error: null,
      errorContext: null,
      isAuthenticating: false,
      isLoading: false,
      connectStartedAt: null,
      wayBack: null,
      // A connect already in flight would otherwise resolve after this and
      // hand the window back a cluster the user just left — bumping the
      // attempt id is what makes disconnecting the last word.
      connectionAttemptId: get().connectionAttemptId + 1,
    });
    if (isAuthenticating && pendingContext) {
      await commands.disconnectCluster(pendingContext).catch((error) => {
        console.error("Error disconnecting:", error);
      });
    }
    await commands.focusCluster(null).catch(() => null);
    await get().release();
  },

  release: async () => {
    const state = get();
    const keep = new Set(
      [state.currentContext, state.wayBack, ...heldElsewhere()].filter(
        (name): name is string => name !== null
      )
    );
    const asked = ++releases;
    const live = await commands.releaseClusters([...keep]).catch(() => null);
    if (
      !live ||
      asked !== releases ||
      get().connectionAttemptId !== state.connectionAttemptId
    )
      return;
    set({ live });
  },
}));

followConnections(() => useClusterStore.getState().connectionAttemptId);
