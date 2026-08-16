/**
 * Which in-cluster server this person pointed an integration at, per cluster.
 *
 * The sibling of `clusterIdentityStore`, and here for the same reasons. A
 * forward is a choice about *this laptop* — which local port is free on it,
 * whether this person wants a tunnel opened the moment they switch to this
 * cluster — so it belongs beside the alias and the colour rather than in the
 * kubeconfig or in the app's shared config file. Another machine connecting
 * to the same cluster has its own answer.
 *
 * ## What is stored, and what deliberately is not
 *
 * The **Service**, not the pod. `port_forward_pod` targets a pod by name and
 * `autoReconnect` retries that same pod, so a saved pod name is a fact with a
 * shelf life of one rollout. The Service is the durable thing and the pod is
 * looked up again every time the forward comes up — see
 * `integrations/forwarded.ts`.
 *
 * The **local port**, because the saved connection's URL is made of it. Move
 * the port and the address the integration was configured with stops being
 * true; the port is re-checked for a collision when the forward is brought
 * up, and only then moved.
 *
 * @module stores/clusterForwardStore
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ForwardPreference {
  namespace: string;
  service: string;
  remotePort: number;
  /** What the connection's `http://localhost:<port>` address is made of. */
  localPort: number;
  /**
   * Bring it up when this cluster is opened.
   *
   * Off by default and asked for explicitly, because a forward is a listening
   * socket on this machine and an outbound connection into the cluster —
   * neither is something to start on somebody's behalf because they once
   * pressed a button. Off, the integration's row is still drawn and pressing
   * it is what wakes it.
   */
  autoStart: boolean;
}

/** `context` → vendor id → what it points at. */
type Saved = Record<string, Record<string, ForwardPreference>>;

interface ClusterForwardState {
  forwards: Saved;
  remember: (
    context: string,
    vendorId: string,
    preference: ForwardPreference
  ) => void;
  setAutoStart: (context: string, vendorId: string, on: boolean) => void;
  forget: (context: string, vendorId: string) => void;
}

/** Drop an empty cluster, so forgetting the last one leaves no residue. */
function write(
  saved: Saved,
  context: string,
  forCluster: Record<string, ForwardPreference>
): Saved {
  const next = { ...saved };
  if (Object.keys(forCluster).length === 0) delete next[context];
  else next[context] = forCluster;
  return next;
}

export const useClusterForwardStore = create<ClusterForwardState>()(
  persist(
    (set) => ({
      forwards: {},
      remember: (context, vendorId, preference) =>
        set((state) => ({
          forwards: write(state.forwards, context, {
            ...state.forwards[context],
            [vendorId]: preference,
          }),
        })),
      setAutoStart: (context, vendorId, on) =>
        set((state) => {
          const found = state.forwards[context]?.[vendorId];
          if (!found) return state;
          return {
            forwards: write(state.forwards, context, {
              ...state.forwards[context],
              [vendorId]: { ...found, autoStart: on },
            }),
          };
        }),
      forget: (context, vendorId) =>
        set((state) => {
          const forCluster = { ...state.forwards[context] };
          delete forCluster[vendorId];
          return { forwards: write(state.forwards, context, forCluster) };
        }),
    }),
    { name: "cluster-forwards" }
  )
);

/** What this cluster forwards for that vendor, or `undefined`. */
export function useForwardPreference(
  context: string | null,
  vendorId: string
): ForwardPreference | undefined {
  return useClusterForwardStore((state) =>
    context === null ? undefined : state.forwards[context]?.[vendorId]
  );
}

/** Every forward saved for this cluster, as `[vendorId, preference]`. */
export function forwardsFor(
  forwards: Saved,
  context: string | null
): Array<[string, ForwardPreference]> {
  if (context === null) return [];
  return Object.entries(forwards[context] ?? {});
}
