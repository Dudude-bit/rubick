/**
 * Flows as they happen, from whatever supplies `traffic.live`: a stream per
 * scope, held while the caller is on screen and let go when it leaves.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import type {
  LiveEnd,
  LivePair,
  RelayAt,
  UnreachedNode,
} from "@/generated/types";
import { useCapability } from "@/integrations";
import { listenBridgeLag } from "@/lib/events";
import { livePairId, type LiveBatch } from "@/lib/traffic";
import { useClusterStore } from "@/stores/clusterStore";

export interface LiveSnapshot {
  /** `connecting` until the relay is named, `ended` once it said how it ended. */
  phase: "connecting" | "live" | "ended";
  pairs: ReadonlyMap<string, LivePair>;
  relay: RelayAt | null;
  lost: number;
  untracked: number;
  /** Nodes whose flows do not arrive: their silence is not quiet. */
  unreached: readonly UnreachedNode[];
  end: LiveEnd | null;
  /** Why the stream could not be opened. */
  error: unknown;
}

const EMPTY: LiveSnapshot = {
  phase: "connecting",
  pairs: new Map(),
  relay: null,
  lost: 0,
  untracked: 0,
  unreached: [],
  end: null,
  error: null,
};

/** What a live stream sent, a batch replacing only the pairs it names. */
export class LiveStore {
  private current: LiveSnapshot = EMPTY;
  private heard = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.heard.add(listener);
    return () => void this.heard.delete(listener);
  };

  snapshot = () => this.current;

  reset() {
    this.publish(EMPTY);
  }

  apply(batch: LiveBatch) {
    const pairs = new Map(this.current.pairs);
    for (const gone of batch.gone) pairs.delete(livePairId(gone));
    for (const pair of batch.pairs) pairs.set(livePairId(pair), pair);
    this.publish({
      ...this.current,
      phase: this.current.phase === "ended" ? "ended" : "live",
      pairs,
      relay: batch.relay ?? this.current.relay,
      lost: batch.lost,
      untracked: batch.untracked,
      unreached: batch.unreached,
    });
  }

  ended(end: LiveEnd) {
    this.publish({ ...this.current, phase: "ended", end });
  }

  failed(error: unknown) {
    this.publish({ ...this.current, phase: "ended", error });
  }

  private publish(next: LiveSnapshot) {
    this.current = next;
    for (const listener of this.heard) listener();
  }
}

/** `null` where nothing supplies live flows; otherwise the stream's snapshot. */
export function useLiveTraffic(
  scope: string[] | null,
  enabled: boolean
): LiveSnapshot | null {
  const live = useCapability("traffic.live");
  const [store] = useState(() => new LiveStore());
  const context = useClusterStore((s) => s.currentContext);
  const [attempt, setAttempt] = useState(0);
  const scopeKey = scope === null ? "\u0000all" : scope.join(",");

  useEffect(() => {
    if (!enabled || !live || !context) return;
    store.reset();
    let again: ReturnType<typeof setTimeout> | null = null;
    const stop = live.open(
      scopeKey === "\u0000all" ? null : scopeKey.split(","),
      {
        batch: (batch) => store.apply(batch),
        ended: (end) => store.ended(end),
        failed: (error) => store.failed(error),
      }
    );
    // A lost batch leaves the held pairs wrong with nothing to say so.
    const lag = listenBridgeLag((_missed, waitMs) => {
      if (!again) again = setTimeout(() => setAttempt((n) => n + 1), waitMs);
    });
    return () => {
      stop();
      if (again) clearTimeout(again);
      void lag.then((off) => off());
    };
  }, [store, live, enabled, context, scopeKey, attempt]);

  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot);
  return live ? snapshot : null;
}
