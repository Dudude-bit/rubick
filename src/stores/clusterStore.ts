/**
 * Cluster Store
 *
 * Manages Kubernetes cluster connection state including contexts,
 * namespaces, and connection status. Handles loading contexts from
 * kubeconfig and connecting/disconnecting from clusters.
 *
 * @module stores/clusterStore
 */

import { create } from "zustand";

import type { ContextInfo } from "@/generated/types";
import { normalizeTauriError } from "@/lib/error-utils";
import { commands } from "@/lib/commands";
import { credentialsRestored } from "@/lib/credentials";
import { clampScope, decodeScope, wireNamespace } from "@/lib/namespace-scope";
import { useClusterRecencyStore } from "./clusterRecencyStore";

/** Cluster store state and actions */
interface ClusterState {
  contexts: ContextInfo[];
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

  // Actions
  loadContexts: () => Promise<void>;
  switchContext: (context: string) => Promise<void>;
  switchNamespace: (namespace: string) => Promise<void>;
  /** Look at these namespaces, or at the whole cluster for an empty list. */
  setNamespaceScope: (namespaces: string[]) => Promise<void>;
  connect: (context?: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

/**
 * What the window looks at after moving to `context`.
 *
 * Staying put keeps whatever is on screen. Moving restores what that cluster
 * was last left on — clearing it was the behaviour somebody with rights to
 * two namespaces in each of six clusters had to undo on every switch.
 */
function scopeFor(
  state: { savedScopes: Record<string, string[]>; namespaceScope: string[] },
  context: string,
  changed: boolean
): { namespaceScope: string[]; currentNamespace: string } {
  const scope = changed
    ? clampScope(state.savedScopes[context] ?? [])
    : state.namespaceScope;
  return { namespaceScope: scope, currentNamespace: wireNamespace(scope) };
}

export const useClusterStore = create<ClusterState>((set, get) => ({
  contexts: [],
  currentContext: null,
  currentNamespace: "", // Empty string means all namespaces
  namespaceScope: [],
  savedScopes: {},
  isConnected: false,
  isLoading: false,
  isAuthenticating: false,
  error: null,
  pendingContext: null,
  errorContext: null,
  connectionAttemptId: 0,
  connectStartedAt: null,

  loadContexts: async () => {
    set({ isLoading: true, error: null, errorContext: null });
    try {
      const contexts = await commands.listContexts();
      const currentContext = await commands.getCurrentContext();
      set({ contexts, currentContext, isLoading: false });

      // Restore saved cluster preferences and auto-connect
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
          // Auto-connect to saved cluster
          get().connect(prefs.lastContext);
        }
      } catch {
        // Ignore errors loading preferences - not critical
      }
    } catch (error) {
      set({
        error: normalizeTauriError(error),
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
      commands
        .saveClusterPreferences(null, context, wireNamespace(scope), scope)
        .catch(() => {
          // Ignore errors saving preferences - not critical
        });
    }
  },

  connect: async (context?: string) => {
    const targetContext = context ?? get().currentContext;
    if (!targetContext) {
      set({ error: "No cluster selected", errorContext: null });
      return;
    }

    // Prevent multiple concurrent connection attempts to the same context
    if (get().isAuthenticating && get().pendingContext === targetContext) {
      return;
    }

    const previousContext = get().currentContext;
    if (previousContext && previousContext !== targetContext) {
      commands.disconnectCluster(previousContext).catch(() => {
        // Best-effort cleanup to avoid stale auth sessions.
      });
    }
    const changed = Boolean(
      previousContext && previousContext !== targetContext
    );
    const attemptId = get().connectionAttemptId + 1;

    set({
      isLoading: true,
      isAuthenticating: true,
      error: null,
      errorContext: null,
      pendingContext: targetContext,
      currentContext: targetContext,
      ...scopeFor(get(), targetContext, changed),
      isConnected: false,
      connectionAttemptId: attemptId,
      connectStartedAt: Date.now(),
    });
    try {
      const info = await commands.connectCluster(targetContext);
      if (get().connectionAttemptId !== attemptId) {
        return;
      }
      const connectedContext = info.context || targetContext;
      set({
        currentContext: connectedContext,
        isConnected: true,
        isLoading: false,
        isAuthenticating: false,
        pendingContext: null,
        connectStartedAt: null,
      });
      // A connect that landed is a session the cluster accepts, and it is
      // the only proof that lifts the refusal banner: "Sign in again"
      // reconnects to the same context, so the context-change clearing in
      // useExpiredCredentials never fires for exactly the button built to
      // recover from it.
      credentialsRestored();
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
    } catch (error) {
      if (get().connectionAttemptId !== attemptId) {
        return;
      }
      // Normalize error message - Tauri errors can be objects
      const errorMessage = normalizeTauriError(error);
      set({
        error: errorMessage,
        errorContext: targetContext,
        isLoading: false,
        isAuthenticating: false,
        isConnected: false,
        pendingContext: null,
        connectStartedAt: null,
      });
    }
  },

  disconnect: async () => {
    const { currentContext } = get();
    if (currentContext) {
      try {
        await commands.disconnectCluster(currentContext);
      } catch (error) {
        console.error("Error disconnecting:", error);
      }
    }
    set({
      isConnected: false,
      currentContext: null,
      pendingContext: null,
      error: null,
      errorContext: null,
      isAuthenticating: false,
      isLoading: false,
      connectStartedAt: null,
      // A connect already in flight would otherwise resolve after this and
      // hand the window back a cluster the user just left — bumping the
      // attempt id is what makes disconnecting the last word.
      connectionAttemptId: get().connectionAttemptId + 1,
    });
  },
}));
