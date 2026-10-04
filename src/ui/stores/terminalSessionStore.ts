/**
 * Terminal Session Store
 *
 * Tracks active terminal sessions for the Activity Panel.
 * Sessions are registered when terminals are opened and
 * removed when they are closed.
 *
 * @module stores/terminalSessionStore
 */

import { create } from "zustand";

export type TerminalSessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/**
 * Terminal session entry
 *
 * Represents an active terminal session to a pod container.
 */
export interface TerminalSessionEntry {
  /** Unique session identifier */
  id: string;
  /** Kubernetes context name */
  context: string;
  /** Target pod name */
  podName: string;
  /** Target namespace */
  namespace: string;
  /** Container name within the pod */
  containerName: string;
  /** Current session status */
  status: TerminalSessionStatus;
  /** Error message if status is "error" */
  errorMessage?: string;
  /** ISO timestamp when session was created */
  createdAt: string;
}

interface TerminalSessionState {
  /** All active terminal sessions */
  sessions: TerminalSessionEntry[];

  /**
   * Add a new terminal session
   */
  addSession: (session: Omit<TerminalSessionEntry, "createdAt">) => void;

  /**
   * Update an existing session
   */
  updateSession: (
    id: string,
    updates: Partial<Omit<TerminalSessionEntry, "id" | "createdAt">>
  ) => void;

  /**
   * Remove a session by ID
   */
  removeSession: (id: string) => void;

  /**
   * Get sessions for a specific context
   */
  getSessionsForContext: (context: string) => TerminalSessionEntry[];

  /**
   * Get active (connected) sessions count
   */
  getActiveCount: () => number;

  /**
   * Clear all sessions
   */
  clearAll: () => void;
}

export const useTerminalSessionStore = create<TerminalSessionState>(
  (set, get) => ({
    sessions: [],

    addSession: (session) => {
      const entry: TerminalSessionEntry = {
        ...session,
        createdAt: new Date().toISOString(),
      };

      set((state) => ({
        // Replace existing session with same ID or add new
        sessions: [...state.sessions.filter((s) => s.id !== session.id), entry],
      }));
    },

    updateSession: (id, updates) => {
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === id ? { ...session, ...updates } : session
        ),
      }));
    },

    removeSession: (id) => {
      set((state) => ({
        sessions: state.sessions.filter((session) => session.id !== id),
      }));
    },

    getSessionsForContext: (context) => {
      return get().sessions.filter((session) => session.context === context);
    },

    getActiveCount: () => {
      return get().sessions.filter((session) => session.status === "connected")
        .length;
    },

    clearAll: () => {
      set({ sessions: [] });
    },
  })
);
