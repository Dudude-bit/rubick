import { useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { commands } from "@/lib/commands";
import { useT } from "@/i18n/useT";

/** Operation tag — mirrors backend `WatchOp`. */
type WatchOp = "applied" | "deleted" | "restarted" | "synced" | "failed";

/** One change inside a batch — mirrors backend `WatchChange`. */
interface WatchChange<T> {
  op: WatchOp;
  /** `null` on the resync markers and on `failed`. */
  resource: T | null;
}

interface ResourceEventPayload<T> {
  stream_id: string;
  /** In arrival order, never empty. */
  changes: Array<WatchChange<T>>;
  /** Set on `failed` — backend's error description. `null` for every
   *  other op. */
  error: string | null;
}

interface UseResourceWatchOptions {
  /**
   * `true` once dependencies are ready (current namespace, etc.).
   * The hook short-circuits and does nothing while `false`.
   */
  enabled: boolean;
  /**
   * Async subscription factory. Returns a stream id; the hook owns
   * the rest of the lifecycle (listen + gate release + unsubscribe).
   */
  subscribe: () => Promise<string>;
  /** TanStack Query cache key the watch should keep up to date. */
  queryKey: QueryKey;
  /**
   * Called on a backend `failed` event — typically RBAC `watch` denial or a
   * persistent network problem. The cache is NOT mutated for those; the
   * consumer decides what to do (toast, fall back to polling, …).
   */
  onError?: (error: string) => void;
  /**
   * Called once when a non-failed event arrives after a failed one: the
   * watcher recovered. Consumers flip watchFailed back to false here, which
   * stops the polling fallback and reverts to pure-watch updates.
   */
  onRecovered?: () => void;
}

export interface ResourceWatchState {
  /**
   * A resync is in flight: the watcher is re-listing the collection, so the
   * cached rows are the last complete state and not the current one. Surfaces
   * show what they have — or a skeleton where they have nothing — not an
   * empty state that reads as "your cluster has none of these".
   */
  resyncing: boolean;
}

/** Matches `EVENT_BRIDGE_LAGGED` in `src-tauri/src/main.rs`. */
const EVENT_BRIDGE_LAGGED = "event-bridge-lagged";

/**
 * Subscribes to a backend resource watch, listens for `resource-event` Tauri
 * events and updates the TanStack Query cache directly.
 *
 * Same deferred-start handshake as `useGenericTerminalSession` and
 * `useLogStream`: `commands.resourceWatchSubscribed` is called only after
 * `listen()` has resolved, so the backend's first `applied`/`restarted`
 * events cannot land in the void.
 */
export function useResourceWatch<
  T extends { name: string; namespace?: string | null },
>({
  enabled,
  subscribe,
  queryKey,
  onError,
  onRecovered,
}: UseResourceWatchOptions): ResourceWatchState {
  const t = useT();
  const queryClient = useQueryClient();
  const [resyncing, setResyncing] = useState(false);
  // Latest callbacks captured via refs so flipping a useState in
  // either callback doesn't tear down the subscription.
  const onErrorRef = useRef(onError);
  const onRecoveredRef = useRef(onRecovered);
  const tRef = useRef(t);
  useEffect(() => {
    onErrorRef.current = onError;
    onRecoveredRef.current = onRecovered;
    tRef.current = t;
  }, [onError, onRecovered, t]);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    let streamId: string | null = null;
    let unlisten: (() => void) | null = null;
    // Tracks whether the last stream state was a failure, so `onRecovered`
    // fires once per failure→recovery transition and not on every event.
    let inFailedState = false;
    // The rows a resync has delivered so far, held here rather than in
    // the cache until the backend says the burst is complete.
    let staged: Map<string, T> | null = null;

    // Give up on a resync that can no longer complete. What was staged is
    // dropped rather than committed — a half-delivered burst is not a
    // state — and the surface stops waiting on one, which it would
    // otherwise do forever.
    const abandonResync = () => {
      staged = null;
      setResyncing(false);
    };

    const teardown = async () => {
      active = false;
      abandonResync();
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      if (streamId) {
        const id = streamId;
        streamId = null;
        try {
          await commands.unsubscribeResourceWatch(id);
        } catch (err) {
          console.error("Failed to unsubscribe resource watch:", err);
        }
      }
    };

    (async () => {
      try {
        const id = await subscribe();
        if (!active) {
          await commands.unsubscribeResourceWatch(id).catch(() => {});
          return;
        }
        streamId = id;

        const off = await listen<ResourceEventPayload<T>>(
          "resource-event",
          (event) => {
            const payload = event.payload;
            if (payload.stream_id !== id) return;
            if (payload.changes.some((change) => change.op === "failed")) {
              inFailedState = true;
              abandonResync();
              onErrorRef.current?.(
                payload.error ?? tRef.current("action", "resourceWatchFailed")
              );
              return;
            }
            if (payload.changes.length === 0) return;
            if (inFailedState) {
              inFailedState = false;
              onRecoveredRef.current?.();
            }

            // Live changes accumulate and land as one cache write, so a
            // batch is one render no matter how many objects moved.
            let live: Array<WatchChange<T>> = [];
            for (const change of payload.changes) {
              if (change.op === "restarted") {
                staged = new Map();
                setResyncing(true);
                // The resync's list is the whole truth; anything from
                // before it is about to be superseded.
                live = [];
                continue;
              }
              if (change.op === "synced") {
                const rows = staged;
                staged = null;
                setResyncing(false);
                if (rows) {
                  queryClient.setQueryData<T[]>(queryKey, [...rows.values()]);
                }
                continue;
              }
              if (staged) {
                stage(staged, change);
              } else {
                live.push(change);
              }
            }

            if (live.length > 0) {
              const changes = live;
              queryClient.setQueryData<T[]>(queryKey, (prev) =>
                applyChanges(prev ?? [], changes)
              );
            }
          }
        );

        // The bridge dropping events is this watch failing, whatever the
        // stream itself is doing: a resync replaces the cache from a burst,
        // so events lost in it are rows that never arrive — the list is not
        // stale, it is short, and nothing polls it back while it believes it
        // is live. Same treatment as a failed stream: say so, drop the badge,
        // start polling again.
        const offLagged = await listen<number>(EVENT_BRIDGE_LAGGED, (event) => {
          inFailedState = true;
          // A resync missing an unknown number of its own rows is not a
          // state to swap in — committing it would delete rows that exist.
          abandonResync();
          onErrorRef.current?.(
            tRef.current("action", "eventBridgeLagged", { n: event.payload })
          );
        });

        if (!active) {
          off();
          offLagged();
          return;
        }
        unlisten = () => {
          off();
          offLagged();
        };

        // Listener installed — release the backend gate. A failure here means
        // the session was already torn down (race with cleanup): log, no crash.
        try {
          await commands.resourceWatchSubscribed(id);
        } catch (err) {
          if (active) {
            console.error("Failed to subscribe resource watch:", err);
          }
        }
      } catch (err) {
        if (active) {
          console.error("Failed to start resource watch:", err);
        }
      }
    })();

    return () => {
      void teardown();
    };
    // queryKey is compared by reference on purpose. Consumers pass a stable,
    // memoised key (`queryKeys.resources(...)` inside a useMemo); when the
    // namespace or kind changes the reference changes too, and re-subscribing
    // is correct — the watch belongs to that key.
  }, [enabled, subscribe, queryClient, queryKey]);

  return { resyncing };
}

/** Name plus namespace, which is what identifies a row in a list. */
function identify<T extends { name: string; namespace?: string | null }>(
  item: T
): string {
  return `${item.namespace ?? ""}\0${item.name}`;
}

function stage<T extends { name: string; namespace?: string | null }>(
  rows: Map<string, T>,
  change: WatchChange<T>
) {
  const incoming = change.resource;
  if (!incoming) return;
  if (change.op === "deleted") rows.delete(identify(incoming));
  else rows.set(identify(incoming), incoming);
}

/**
 * The list with a batch of changes folded in.
 *
 * Keyed rather than scanned: `findIndex` per change is O(N) against a list
 * the same burst is growing, so an init burst of a thousand objects costs
 * half a million name comparisons and as many copied array slots to build
 * what one pass builds.
 *
 * A `Map` keeps insertion order and leaves a replaced row where it was,
 * so rows do not jump around under an update.
 */
function applyChanges<T extends { name: string; namespace?: string | null }>(
  list: T[],
  changes: Array<WatchChange<T>>
): T[] {
  const rows = new Map<string, T>();
  for (const item of list) rows.set(identify(item), item);
  for (const change of changes) stage(rows, change);
  return [...rows.values()];
}
