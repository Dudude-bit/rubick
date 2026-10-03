/**
 * Which clusters this person actually works in.
 *
 * A laptop's kubeconfig accretes contexts and never sheds them, so an
 * alphabetical list puts `arn:aws:eks:…` above the two clusters anyone
 * opens nine times out of ten. Recency is the only ordering that gets the
 * answer to the top without asking to be configured.
 *
 * It lives here rather than in `ClusterPreferences` on the backend
 * because it is a view preference for one window, written on every
 * connect and read by nothing else — the backend already persists
 * `lastContext` for auto-connect, which is a different question ("which
 * one do I resume") from this one ("which ones do you use").
 *
 * @module stores/clusterRecencyStore
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ClusterRecencyState {
  /** Context name to the epoch millisecond it was last connected. */
  lastUsed: Record<string, number>;
  recordUse: (context: string) => void;
}

export const useClusterRecencyStore = create<ClusterRecencyState>()(
  persist(
    (set) => ({
      lastUsed: {},
      recordUse: (context) =>
        set((state) => ({
          lastUsed: { ...state.lastUsed, [context]: Date.now() },
        })),
    }),
    {
      name: "cluster-recency",
      version: 1,
      // Nothing shipped before version 1, so anything without a
      // well-formed map is a foreign or corrupted payload: start empty
      // rather than order the list by garbage.
      migrate: (persisted) => {
        const stored = (persisted as { lastUsed?: unknown } | undefined)
          ?.lastUsed;
        const lastUsed: Record<string, number> = {};
        if (stored && typeof stored === "object") {
          for (const [context, at] of Object.entries(stored)) {
            if (typeof at === "number" && Number.isFinite(at)) {
              lastUsed[context] = at;
            }
          }
        }
        return { lastUsed } as ClusterRecencyState;
      },
    }
  )
);

/**
 * Split a context list into the ones that have been connected to, most
 * recent first, and the ones that have not.
 *
 * The unused half keeps the kubeconfig's own order: it is a reference
 * list, and the file's order is the only one its author chose.
 */
export function splitByRecency<T extends { name: string }>(
  contexts: T[],
  lastUsed: Record<string, number>
): { recent: T[]; rest: T[] } {
  const recent: T[] = [];
  const rest: T[] = [];
  for (const context of contexts) {
    (lastUsed[context.name] ? recent : rest).push(context);
  }
  recent.sort((a, b) => lastUsed[b.name] - lastUsed[a.name]);
  return { recent, rest };
}
