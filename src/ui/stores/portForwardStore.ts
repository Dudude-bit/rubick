/**
 * Port Forward Store
 *
 * Manages port forwarding configurations and active sessions.
 * Persists configs via the Tauri backend and tracks
 * active sessions from the Tauri backend.
 *
 * @module stores/portForwardStore
 */

import { create } from "zustand";
import { commands } from "@/lib/commands";
import type {
  PortForwardConfigInfo,
  PortForwardConfigPayload,
  PortForwardRequest,
  PortForwardSessionInfo,
} from "@/generated/types";

/**
 * Saved port forward configuration
 *
 * Represents a user-defined port forward rule that can be
 * started/stopped and is persisted across sessions.
 */
export interface PortForwardConfig {
  /** Unique identifier */
  id: string;
  /** Kubernetes context name */
  context: string;
  /** Display name for the configuration */
  name: string;
  /** Target pod name */
  pod: string;
  /** Target namespace */
  namespace: string;
  /** Local port to listen on */
  localPort: number;
  /** Remote port on the pod */
  remotePort: number;
  /** Whether to automatically reconnect on failure */
  autoReconnect: boolean;
  /** Whether to auto-start on connect */
  autoStart: boolean;
  /** ISO timestamp when created */
  createdAt: string;
}

/**
 * Active port forward session
 *
 * Represents a currently running port forward from the backend.
 */
export interface PortForwardSession {
  /** Session ID from backend */
  id: string;
  /** Kubernetes context name */
  context: string;
  /** Target pod name */
  pod: string;
  /** Target namespace */
  namespace: string;
  /** Local port being listened on */
  localPort: number;
  /** Remote port on the pod */
  remotePort: number;
  /** Whether auto-reconnect is enabled */
  autoReconnect: boolean;
  /** ISO timestamp when started */
  createdAt: string;
}

/**
 * Port forward status update from backend events
 */
export interface PortForwardStatus {
  /** Session ID */
  id: string;
  /** Target pod name */
  pod: string;
  /** Target namespace */
  namespace: string;
  /** Local port */
  localPort: number;
  /** Remote port */
  remotePort: number;
  /** Current status (e.g., "active", "connecting", "failed") */
  status: string;
  /** Optional status message */
  message?: string | null;
  /** Reconnection attempt number */
  attempt?: number | null;
}

interface PortForwardState {
  configs: PortForwardConfig[];
  sessions: PortForwardSession[];
  statusBySession: Record<string, PortForwardStatus>;
  configsLoaded: boolean;
  refreshConfigs: () => Promise<void>;
  addConfig: (
    config: Omit<PortForwardConfig, "id" | "createdAt">
  ) => Promise<PortForwardConfig>;
  updateConfig: (
    id: string,
    updates: Partial<Omit<PortForwardConfig, "id" | "createdAt">>
  ) => Promise<PortForwardConfig>;
  removeConfig: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  /**
   * Start a forward against a pod, without a saved config behind it.
   *
   * Here rather than at the call site because the call sites forgot. Two of
   * the three ways to start a forward called `commands.portForwardPod`
   * straight and left the store empty, so the forward held a local port,
   * carried traffic, and appeared in no list the app draws — including the
   * one with the Stop button on it. The only way to get the port back was to
   * quit. A start that records itself cannot be half-done.
   */
  startPod: (
    pod: string,
    namespace: string,
    request: PortForwardRequest
  ) => Promise<PortForwardSession>;
  startConfig: (configId: string) => Promise<PortForwardSession>;
  stopSession: (sessionId: string) => Promise<void>;
  startAllForContext: (
    context: string
  ) => Promise<{ started: number; skipped: number; failed: number }>;
  startAutoForContext: (
    context: string
  ) => Promise<{ started: number; skipped: number; failed: number }>;
  setStatus: (status: PortForwardStatus) => void;
}

function mapSession(payload: PortForwardSessionInfo): PortForwardSession {
  return {
    id: payload.id,
    context: payload.context,
    pod: payload.pod,
    namespace: payload.namespace,
    localPort: payload.localPort,
    remotePort: payload.remotePort,
    autoReconnect: payload.autoReconnect,
    createdAt: payload.createdAt,
  };
}

function mapConfig(payload: PortForwardConfigInfo): PortForwardConfig {
  return {
    id: payload.id,
    context: payload.context,
    name: payload.name,
    pod: payload.pod,
    namespace: payload.namespace,
    localPort: payload.localPort,
    remotePort: payload.remotePort,
    autoReconnect: payload.autoReconnect,
    autoStart: payload.autoStart,
    createdAt: payload.createdAt,
  };
}

function toPayload(
  config: Omit<PortForwardConfig, "id" | "createdAt">
): PortForwardConfigPayload {
  return {
    context: config.context,
    name: config.name,
    pod: config.pod,
    namespace: config.namespace,
    localPort: config.localPort,
    remotePort: config.remotePort,
    autoReconnect: config.autoReconnect,
    autoStart: config.autoStart,
  };
}

function sessionKey(item: {
  context: string;
  pod: string;
  namespace: string;
  localPort: number;
  remotePort: number;
}) {
  return `${item.context}:${item.pod}:${item.namespace}:${item.localPort}:${item.remotePort}`;
}

async function startConfigsWithFilter(
  configs: PortForwardConfig[],
  sessions: PortForwardSession[],
  filter: (config: PortForwardConfig) => boolean,
  startConfig: (configId: string) => Promise<PortForwardSession>
) {
  const activeKey = new Set(sessions.map(sessionKey));

  let started = 0;
  let skipped = 0;
  let failed = 0;

  for (const config of configs.filter(filter)) {
    const key = sessionKey(config);
    if (activeKey.has(key)) {
      skipped += 1;
      continue;
    }
    try {
      await startConfig(config.id);
      started += 1;
    } catch (error) {
      console.error("Failed to start port-forward:", error);
      failed += 1;
    }
  }

  return { started, skipped, failed };
}

export const usePortForwardStore = create<PortForwardState>((set, get) => ({
  configs: [],
  sessions: [],
  statusBySession: {},
  configsLoaded: false,

  refreshConfigs: async () => {
    const configs = await commands.listPortForwardConfigs();
    set({ configs: configs.map(mapConfig), configsLoaded: true });
  },

  addConfig: async (config) => {
    const payload = toPayload(config);
    const created = await commands.createPortForwardConfig(payload);
    const mapped = mapConfig(created);
    set((state) => ({
      configs: [
        ...state.configs.filter((item) => item.id !== mapped.id),
        mapped,
      ],
    }));
    return mapped;
  },

  updateConfig: async (id, updates) => {
    const existing = get().configs.find((item) => item.id === id);
    if (!existing) {
      throw new Error("Port-forward config not found");
    }
    const payload = toPayload({ ...existing, ...updates });
    const updated = await commands.updatePortForwardConfig(id, payload);
    const mapped = mapConfig(updated);
    set((state) => ({
      configs: state.configs.map((item) => (item.id === id ? mapped : item)),
    }));
    return mapped;
  },

  removeConfig: async (id) => {
    await commands.deletePortForwardConfig(id);
    set((state) => ({
      configs: state.configs.filter((config) => config.id !== id),
    }));
  },

  refreshSessions: async () => {
    const sessions = await commands.listPortForwards();
    set({ sessions: sessions.map(mapSession) });
  },

  startPod: async (pod, namespace, request) => {
    const session = await commands.portForwardPod(pod, namespace, request);
    const mapped = mapSession(session);
    set((state) => ({
      sessions: [...state.sessions.filter((s) => s.id !== mapped.id), mapped],
    }));
    return mapped;
  },

  startConfig: async (configId) => {
    const config = get().configs.find((item) => item.id === configId);
    if (!config) {
      throw new Error("Port-forward config not found");
    }

    return get().startPod(config.pod, config.namespace, {
      localPort: config.localPort,
      remotePort: config.remotePort,
      autoReconnect: config.autoReconnect,
    });
  },

  stopSession: async (sessionId) => {
    await commands.stopPortForward(sessionId);
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== sessionId),
    }));
  },

  startAllForContext: async (context) => {
    const { configs, sessions, startConfig } = get();
    return startConfigsWithFilter(
      configs,
      sessions,
      (config) => config.context === context,
      startConfig
    );
  },

  startAutoForContext: async (context) => {
    const { configs, sessions, startConfig } = get();
    return startConfigsWithFilter(
      configs,
      sessions,
      (config) => config.context === context && config.autoStart,
      startConfig
    );
  },

  setStatus: (status) => {
    set((state) => ({
      statusBySession: {
        ...state.statusBySession,
        [status.id]: status,
      },
    }));
  },
}));
