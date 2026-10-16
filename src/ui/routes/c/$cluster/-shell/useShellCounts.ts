import { useEffect } from "react";
import { create } from "zustand";

import type { ClusterOverview, ResourceCounts } from "@/generated/types";
import { useAttention } from "@/hooks/useAttention";
import {
  useOverviewFollowed,
  useScopedOverview,
  WATCHED_COUNTS,
} from "@/hooks/useClusterOverview";
import type { Attention } from "@/lib/attention";
import { scopeCacheKey } from "@/lib/namespace-scope";
import { EVERY_NAMESPACE } from "@/lib/query-keys";
import { longestInterval, REFRESH_INTERVALS } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowCluster } from "./useWindowCluster";

export interface ShellCounts {
  overview: ClusterOverview | undefined;
  attention: Attention | null;
  /** When the counts on screen were read, if that was before the window turned to this cluster. */
  heldAt: number | null;
  /** When the answer on screen landed, or `null` with none. */
  readAt: number | null;
  /** The longest the counts no watch follows go unread, `false` while they are not read again. */
  withinMs: number | false;
  /** The counts the overview's watched stores hold, read again on each change they take. */
  followed: ReadonlySet<keyof ResourceCounts>;
  /** A re-read of the counts on screen has waited past the slow-read grace. */
  late: boolean;
  /** The last re-read of the counts on screen failed. */
  failed: boolean;
}

interface Held {
  overview: ClusterOverview;
  attention: Attention;
  at: number;
}

const useHeld = create<Record<string, Held>>(() => ({}));

const NONE: ReadonlySet<keyof ResourceCounts> = new Set();
const WATCHED: ReadonlySet<keyof ResourceCounts> = new Set(
  Object.values(WATCHED_COUNTS).filter((count) => count !== null)
);

/**
 * The counts the sidebar and the status bar draw for the window's scope.
 * A tab switch empties the cache, so a held cluster's last complete counts
 * stand in, marked, until its own answer lands.
 */
export function useShellCounts(): ShellCounts {
  const { context, live } = useWindowCluster();
  const isConnected = useClusterStore((s) => s.isConnected);
  const turnedAt = useClusterStore((s) => s.turnedAt);
  const scope = useClusterStore((s) => s.namespaceScope);
  const scoped = useScopedOverview();
  const followed = useOverviewFollowed(scoped.data) ? WATCHED : NONE;
  const attention = useAttention();
  const key = `${context}\n${scopeCacheKey(scope) ?? EVERY_NAMESPACE}`;
  const answered =
    attention !== null && scoped.data !== undefined && !scoped.isPlaceholderData
      ? scoped.data
      : undefined;
  const at = scoped.dataUpdatedAt;
  const fresh = isConnected && answered !== undefined && at >= turnedAt;
  const { everyMs, slowRead, stale } = scoped.freshness;
  const withinMs =
    everyMs !== false && longestInterval(REFRESH_INTERVALS.overview);

  useEffect(() => {
    if (!fresh || !answered || !attention) return;
    const was = useHeld.getState()[key];
    if (was?.overview === answered && was.attention === attention) return;
    useHeld.setState({ [key]: { overview: answered, attention, at } });
  }, [key, fresh, answered, attention, at]);

  const stored = useHeld((s) => s[key]);
  if (fresh)
    return {
      overview: answered,
      attention,
      heldAt: null,
      readAt: at,
      withinMs,
      followed,
      late: slowRead,
      failed: stale,
    };
  const held =
    answered && attention && (!stored || at > stored.at)
      ? { overview: answered, attention, at }
      : stored;
  // A placeholder is a narrower question in flight here, not a switch.
  if (live && held && !scoped.isPlaceholderData)
    return {
      overview: held.overview,
      attention: held.attention,
      heldAt: held.at,
      readAt: held.at,
      withinMs,
      followed: NONE,
      late: false,
      failed: false,
    };
  const shown = isConnected ? scoped.data : undefined;
  return {
    overview: shown,
    attention: isConnected && !scoped.isPlaceholderData ? attention : null,
    heldAt: null,
    readAt: shown && at > 0 ? at : null,
    withinMs,
    followed: scoped.isPlaceholderData ? NONE : followed,
    late: shown !== undefined && slowRead,
    failed: shown !== undefined && stale,
  };
}
