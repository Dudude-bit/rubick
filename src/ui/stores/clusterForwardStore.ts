/**
 * Which in-cluster server this person pointed an integration at, per cluster.
 *
 * The sibling of `clusterIdentityStore`, and here for the same reasons: a
 * forward is a choice about *this laptop* — which local port is free on it,
 * whether this person wants a tunnel opened the moment they switch to this
 * cluster — so it belongs beside the alias and the colour rather than in the
 * kubeconfig or in the app's shared config file. Another machine connecting
 * to the same cluster has its own answer.
 *
 * The **Service** is saved, not the pod: `port_forward_pod` targets a pod by
 * name and `autoReconnect` retries that same pod, so a saved pod name is a
 * fact with a shelf life of one rollout. The pod is looked up again every
 * time the forward comes up — see `integrations/forwarded.ts`.
 *
 * The **local port** is saved because the connection's URL is made of it:
 * move the port and the address the integration was configured with stops
 * being true. It is re-checked for a collision when the forward is brought
 * up, and only then moved.
 *
 * @module stores/clusterForwardStore
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistedByName } from "@/lib/kept-by-name";
import {
  entriesOf,
  entryOf,
  named,
  withEntry,
  withoutEntry,
  type Named,
} from "@/lib/named";

export interface ForwardPreference {
  namespace: string;
  service: string;
  remotePort: number;
  /** What the connection's `http://localhost:<port>` address is made of. */
  localPort: number;
  /**
   * What follows the port, for an API that does not sit at the root — a
   * VictoriaMetrics under `/prometheus`. Absent on everything saved before
   * this existed, which is the same as empty.
   */
  subpath?: string;
  /**
   * Bring it up when this cluster is opened.
   *
   * Off by default and asked for explicitly, because a forward is a listening
   * socket on this machine and an outbound connection into the cluster —
   * neither is started on somebody's behalf because they once pressed a
   * button. Off, the integration's row is still drawn and pressing it is what
   * wakes it.
   */
  autoStart: boolean;
}

/** `context` → vendor id → what it points at. */
type Saved = Named<Named<ForwardPreference>>;

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
  forCluster: Named<ForwardPreference>
): Saved {
  return entriesOf(forCluster).length === 0
    ? withoutEntry(saved, context)
    : withEntry(saved, context, forCluster);
}

const forClusterOf = (saved: Saved, context: string) =>
  entryOf(saved, context) ?? named<ForwardPreference>();

export const useClusterForwardStore = create<ClusterForwardState>()(
  persist(
    (set) => ({
      forwards: named(),
      remember: (context, vendorId, preference) =>
        set((state) => ({
          forwards: write(
            state.forwards,
            context,
            withEntry(
              forClusterOf(state.forwards, context),
              vendorId,
              preference
            )
          ),
        })),
      setAutoStart: (context, vendorId, on) =>
        set((state) => {
          const forCluster = forClusterOf(state.forwards, context);
          const found = entryOf(forCluster, vendorId);
          if (!found) return state;
          return {
            forwards: write(
              state.forwards,
              context,
              withEntry(forCluster, vendorId, { ...found, autoStart: on })
            ),
          };
        }),
      forget: (context, vendorId) =>
        set((state) => ({
          forwards: write(
            state.forwards,
            context,
            withoutEntry(forClusterOf(state.forwards, context), vendorId)
          ),
        })),
    }),
    { name: "cluster-forwards" }
  )
);

// Another cluster's Services are not this one's to open a tunnel into.
persistedByName((context) =>
  useClusterForwardStore.setState((state) => ({
    forwards: withoutEntry(state.forwards, context),
  }))
);

/** What `context` forwards for that vendor in `forwards`, or `undefined`. */
export function forwardOf(
  forwards: Saved,
  context: string | null,
  vendorId: string
): ForwardPreference | undefined {
  return context === null
    ? undefined
    : entryOf(forClusterOf(forwards, context), vendorId);
}

/** Every forward saved, every cluster's. */
export function everyForward(forwards: Saved): ForwardPreference[] {
  return entriesOf(forwards).flatMap(([, forCluster]) =>
    entriesOf(forCluster).map(([, preference]) => preference)
  );
}

/** What this cluster forwards for that vendor, or `undefined`. */
export function useForwardPreference(
  context: string | null,
  vendorId: string
): ForwardPreference | undefined {
  return useClusterForwardStore((state) =>
    forwardOf(state.forwards, context, vendorId)
  );
}

/** Every forward saved for this cluster, as `[vendorId, preference]`. */
export function forwardsFor(
  forwards: Saved,
  context: string | null
): Array<[string, ForwardPreference]> {
  if (context === null) return [];
  return entriesOf(forClusterOf(forwards, context));
}
