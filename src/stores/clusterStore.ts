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
import { useClusterRecencyStore } from "./clusterRecencyStore";

/** Cluster store state and actions */
interface ClusterState {
  contexts: ContextInfo[];
  currentContext: string | null;
  currentNamespace: string;
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
  connect: (context?: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

export const useClusterStore = create<ClusterState>((set, get) => ({
  contexts: [],
  currentContext: null,
  currentNamespace: "", // Empty string means all namespaces
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
          // Restore saved namespace if available
          const savedNamespace = prefs.namespaces[prefs.lastContext];
          if (savedNamespace) {
            set({ currentNamespace: savedNamespace });
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
    const nextNamespace =
      previousContext && previousContext !== context
        ? ""
        : get().currentNamespace;
    set({
      currentContext: context,
      currentNamespace: nextNamespace,
      error: null,
      errorContext: null,
    });
  },

  switchNamespace: async (namespace: string) => {
    // Don't set isLoading for namespace switch - it causes flickering
    // Just update the namespace immediately, queries will refetch automatically
    const context = get().currentContext;
    set({ currentNamespace: namespace, error: null, errorContext: null });
    // Save namespace preference for this context
    if (context) {
      commands.saveClusterPreferences(null, context, namespace).catch(() => {
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
    const nextNamespace =
      previousContext && previousContext !== targetContext
        ? ""
        : get().currentNamespace;
    const attemptId = get().connectionAttemptId + 1;

    set({
      isLoading: true,
      isAuthenticating: true,
      error: null,
      errorContext: null,
      pendingContext: targetContext,
      currentContext: targetContext,
      currentNamespace: nextNamespace,
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
      // Only a connection that landed counts as "used": ordering the
      // front door by clusters the reader failed to reach would put the
      // broken ones on top.
      useClusterRecencyStore.getState().recordUse(connectedContext);
      // Save selected cluster on successful connection
      commands
        .saveClusterPreferences(connectedContext, null, null)
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
