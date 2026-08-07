/**
 * The parts of a cluster's identity this person chose, rather than the ones
 * derived from its name.
 *
 * `arn:aws:eks:us-east-1:1234:cluster/prod` is fifty characters of account
 * number wrapped around the one word anybody reads, and the hash that picks
 * its colour cannot tell two unrelated clusters apart on purpose. Both are
 * fixable by the one reader who knows which cluster is which.
 *
 * It is deliberately not written to the kubeconfig. That file is shared,
 * often generated and sometimes in version control; what one person likes
 * to call a cluster on one laptop has no business in it. So this lives
 * beside `clusterRecencyStore` — same shape, same `persist` discipline,
 * same reason: a view preference for this machine and nothing else.
 *
 * @module stores/clusterIdentityStore
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { CLUSTER_HUES } from "@/lib/cluster-identity";

export interface ClusterMark {
  /**
   * What to call it instead of its context name. Stored as typed, because
   * trimming between keystrokes makes a space impossible to type; the
   * trimmed value is what `aliasOf` hands out.
   */
  alias?: string;
  /** One of `CLUSTER_HUES`, or absent for the colour derived from the name. */
  hue?: number;
}

interface ClusterIdentityState {
  marks: Record<string, ClusterMark>;
  setAlias: (context: string, alias: string) => void;
  setHue: (context: string, hue: number | null) => void;
}

/** Drop a mark that no longer says anything, so a reset leaves no residue. */
function write(
  marks: Record<string, ClusterMark>,
  context: string,
  mark: ClusterMark
): Record<string, ClusterMark> {
  const next = { ...marks };
  if (mark.alias === undefined && mark.hue === undefined) delete next[context];
  else next[context] = mark;
  return next;
}

export const useClusterIdentityStore = create<ClusterIdentityState>()(
  persist(
    (set) => ({
      marks: {},
      setAlias: (context, alias) =>
        set((state) => ({
          marks: write(state.marks, context, {
            ...state.marks[context],
            alias: alias.trim() === "" ? undefined : alias,
          }),
        })),
      setHue: (context, hue) =>
        set((state) => ({
          marks: write(state.marks, context, {
            ...state.marks[context],
            hue: hue ?? undefined,
          }),
        })),
    }),
    {
      name: "cluster-identity",
      version: 1,
      // Nothing shipped before version 1, so anything malformed is a
      // foreign or corrupted payload. Every field is checked rather than
      // trusted: a hue that is not on the palette would paint a cluster a
      // colour the themes were never calibrated for, which is exactly the
      // failure the fixed hue list exists to prevent.
      migrate: (persisted) => {
        const stored = (persisted as { marks?: unknown } | undefined)?.marks;
        const marks: Record<string, ClusterMark> = {};
        if (stored && typeof stored === "object") {
          for (const [context, value] of Object.entries(stored)) {
            const raw = value as ClusterMark | undefined;
            const mark: ClusterMark = {};
            if (typeof raw?.alias === "string" && raw.alias.trim() !== "") {
              mark.alias = raw.alias;
            }
            if (
              typeof raw?.hue === "number" &&
              (CLUSTER_HUES as readonly number[]).includes(raw.hue)
            ) {
              mark.hue = raw.hue;
            }
            if (mark.alias !== undefined || mark.hue !== undefined) {
              marks[context] = mark;
            }
          }
        }
        return { marks } as ClusterIdentityState;
      },
    }
  )
);

/** What this cluster is called, or nothing if it is called what it is named. */
export function aliasOf(
  marks: Record<string, ClusterMark>,
  context: string
): string | undefined {
  return marks[context]?.alias?.trim() || undefined;
}

/** The mark for one cluster, without re-rendering on every other cluster's. */
export function useClusterMark(
  context: string | null | undefined
): ClusterMark {
  return (
    useClusterIdentityStore((s) => (context ? s.marks[context] : EMPTY)) ??
    EMPTY
  );
}

const EMPTY: ClusterMark = {};
