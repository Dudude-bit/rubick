import { useEffect, useRef, useState } from "react";
import {
  hashKey,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import {
  listenBridgeLag,
  listenResourceEvents,
  type ResourceChange,
} from "@/lib/events";
import { useRenewals } from "@/hooks/useCredentialRenewal";
import { useT } from "@/i18n/useT";
import type { Scoped } from "@/generated/types";
import { watched } from "@/lib/watched-rows";
import { queryKeys } from "@/lib/query-keys";
import { useWindowActivity } from "@/lib/window-activity";

interface UseResourceWatchOptions<T> {
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
  /** The cache entry the watch keeps up to date: a list's `Scoped` answer. */
  queryKey: QueryKey;
  /**
   * Where a row's own object is cached, its manifest included. The peek, the
   * page and the row menu poll them, and read them again when the watch has
   * seen the row change.
   */
  detail?: (row: T) => readonly QueryKey[];
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
  /**
   * Whether `a` stands before `b`, for a list kept in an order of its own. A
   * row whose change moves it is moved, and a resync is put in this order.
   * Without one, rows keep the API's order, namespace then name.
   */
  order?: (a: T, b: T) => boolean;
  /**
   * The most rows a list in an order of its own holds; see {@link Keep}. The
   * rest are dropped as they arrive, and the entry's `cut` names the classes
   * that lost any.
   */
  keep?: Keep<T>;
  /** Whether a list growing or shrinking re-reads the overview's counts. */
  recount?: boolean;
  /**
   * Whether a list delivered by the stream reads the panels in `detail` again
   * where they answered before it was asked for: a change between the two
   * arrives in the list, never as a change of its own. For a page's own
   * watches, whose rows are few.
   */
  behind?: boolean;
  /** Called when a change after the list lands: a read taken before it is behind. */
  onChange?: () => void;
  /** How long a burst of changes settles before `detail` is read again. */
  settleMs?: number;
}

/** What a list in an order of its own holds at most. */
export interface Keep<T> {
  /** The most rows of one class: its first in the list's order. */
  rows: number;
  /** The class a row is counted in. */
  of: (row: T) => string;
}

/** A watched list's entry; `cut` is the classes whose rows past `keep` were dropped. */
export type Kept<T> = Scoped<T> & { cut?: readonly string[] };

export interface ResourceWatchState {
  /**
   * A resync is in flight: the watcher is re-listing the collection, so the
   * cached rows are the last complete state and not the current one. Surfaces
   * show what they have — or a skeleton where they have nothing — not an
   * empty state that reads as "your cluster has none of these".
   */
  resyncing: boolean;
}

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
  detail,
  onError,
  onRecovered,
  order,
  keep,
  recount = true,
  behind = false,
  onChange,
  settleMs = DETAIL_MS,
}: UseResourceWatchOptions<T>): ResourceWatchState {
  const t = useT();
  const queryClient = useQueryClient();
  const renewals = useRenewals();
  const [resyncing, setResyncing] = useState(false);
  // Counts the streams the bridge dropped events of: each is subscribed again.
  const [dropped, setDropped] = useState(0);
  // Outlives the stream: a renewal or re-enable subscribes again under the
  // same key, and only an answer may end the failure the consumer was told of.
  const failedFor = useRef<QueryKey | null>(null);
  // Latest callbacks captured via refs so flipping a useState in
  // either callback doesn't tear down the subscription.
  const onErrorRef = useRef(onError);
  const onRecoveredRef = useRef(onRecovered);
  const detailRef = useRef(detail);
  const tRef = useRef(t);
  const orderRef = useRef(order);
  const keepRef = useRef(keep);
  const recountRef = useRef(recount);
  const behindRef = useRef(behind);
  const onChangeRef = useRef(onChange);
  const settleRef = useRef(settleMs);
  useEffect(() => {
    onErrorRef.current = onError;
    onRecoveredRef.current = onRecovered;
    detailRef.current = detail;
    tRef.current = t;
    orderRef.current = order;
    keepRef.current = keep;
    recountRef.current = recount;
    behindRef.current = behind;
    onChangeRef.current = onChange;
    settleRef.current = settleMs;
  }, [
    onError,
    onRecovered,
    detail,
    t,
    order,
    keep,
    recount,
    behind,
    onChange,
    settleMs,
  ]);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    let streamId: string | null = null;
    let unlisten: (() => void) | null = null;
    // The bridge dropped events of this stream: nothing more of it is taken.
    let over = false;
    // The wait `listenBridgeLag` asked for before the collection is listed again.
    let again: ReturnType<typeof setTimeout> | null = null;
    // Tracks whether the last stream state was a failure, so `onRecovered`
    // fires once per failure→recovery transition and not on every event.
    let inFailedState = failedFor.current === queryKey;
    const fail = () => {
      inFailedState = true;
      failedFor.current = queryKey;
    };
    // The rows a resync has delivered so far, held here rather than in
    // the cache until the backend says the burst is complete: by key as
    // they arrive, or in the list's own order and within what it keeps.
    let staged: Map<string, T> | Ledger<T> | null = null;
    // When the list in flight was asked for: the gate's release for the
    // first, the marker for a resync. A read of a row's own object that
    // answered before it can miss a change the list carries.
    let listedFrom = 0;
    const held = new Map<string, Slot<T>>();
    let indexedList: T[] | undefined;

    /** The entry as the watch last wrote it. */
    let wrote: Kept<T> | undefined;
    /** `changes` written into the cached list; whether it grew or shrank. */
    const apply = (changes: Array<ResourceChange<T>>): boolean => {
      let recounted = false;
      wrote = queryClient.setQueryData<Kept<T>>(queryKey, (prev) => {
        if (prev?.rows !== indexedList) {
          held.clear();
          prev?.rows.forEach((row, at) => held.set(identify(row), { row, at }));
        }
        const keep = keepRef.current;
        const cut = new Set(prev?.cut);
        const rows = applyChanges(
          prev?.rows ?? [],
          changes,
          held,
          orderRef.current,
          keep,
          cut
        );
        if (prev && rows === prev.rows) return prev;
        recounted = rows.length !== (prev?.rows.length ?? 0);
        return watched({
          rows,
          unread: prev?.unread ?? [],
          ...(keep && {
            cut: prev?.cut?.length === cut.size ? prev.cut : [...cut].sort(),
          }),
        });
      });
      indexedList = wrote?.rows;
      return recounted;
    };

    // A read of the list replaces the cached rows with an answer that may
    // have been taken before a change the watch delivered while it was out,
    // and the watch does not send that change twice: Dana's deleted pod came
    // back under "live" and stayed. So what the watch changed during a read
    // is applied to its answer again; a resync during it is the whole list,
    // and stands instead.
    let missed: Array<ResourceChange<T>> | null =
      queryClient.getQueryState(queryKey)?.fetchStatus === "fetching"
        ? []
        : null;
    let swapped = false;
    const hash = hashKey(queryKey);
    const offReads = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryHash !== hash) return;
      if (event.action.type === "fetch") {
        missed = [];
        swapped = false;
        return;
      }
      if (!missed || event.query.state.fetchStatus !== "idle") return;
      const changes = missed;
      missed = null;
      if (!swapped) apply(changes);
      else if (event.query.state.data !== wrote)
        queryClient.setQueryData(queryKey, wrote);
    });

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
      if (again !== null) clearTimeout(again);
      offReads();
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

        const off = await listenResourceEvents<T>((event) => {
          const payload = event.payload;
          if (payload.stream_id !== id || over) return;
          if (payload.changes.some((change) => change.op === "failed")) {
            fail();
            abandonResync();
            onErrorRef.current?.(
              payload.error ?? tRef.current("action", "resourceWatchFailed")
            );
            return;
          }
          if (payload.changes.length === 0) return;
          // A `restarted` marker says the watcher is trying again; it is
          // not the cluster answering. kube emits one before every list
          // attempt, so a refused watch sends a marker between every pair
          // of failures — and recovering on it put the list back on
          // "live", stopped the polling that was standing in for the
          // watch, and drew a resync that never syncs. The same rule the
          // other side of the boundary applies in `watch::answered`.
          const answered = payload.changes.some(
            (change) => change.op !== "restarted"
          );
          // The marker still does its work — it opens the staging map the
          // resync is collected into, and skipping that left the objects
          // deleted while the watch was down in the cache for good. What
          // it must not do is end the failure.
          if (inFailedState && answered) {
            inFailedState = false;
            failedFor.current = null;
            onRecoveredRef.current?.();
          }

          // Live changes accumulate and land as one cache write, so a
          // batch is one render no matter how many objects moved.
          let live: Array<ResourceChange<T>> = [];
          let burst: Array<ResourceChange<T>> = [];
          const stageBurst = () => {
            if (staged) stage(staged, burst, orderRef.current, keepRef.current);
            burst = [];
          };
          for (const change of payload.changes) {
            if (change.op === "restarted") {
              listedFrom ||= Date.now();
              staged = orderRef.current ? ledger() : new Map();
              // A watch that is failing announces every attempt; saying
              // "resyncing" each time claims progress on a stream that is
              // not making any. The failure is what the reader is shown.
              setResyncing(!inFailedState);
              // The resync's list is the whole truth; anything from
              // before it is about to be superseded.
              live = [];
              burst = [];
              continue;
            }
            if (change.op === "synced") {
              stageBurst();
              const done = staged;
              staged = null;
              setResyncing(false);
              if (done) {
                const rows =
                  done instanceof Map ? [...done.values()] : done.rows;
                const before =
                  queryClient.getQueryData<Scoped<T>>(queryKey)?.rows.length;
                if (
                  recountRef.current &&
                  before !== undefined &&
                  before !== rows.length
                )
                  readSoon(queryClient, queryKeys.everyOverview(), COUNTS_MS);
                // Synced is every namespace of the stream answering, so
                // nothing in the scope is unread any more.
                wrote = queryClient.setQueryData<Kept<T>>(queryKey, {
                  rows,
                  unread: [],
                  ...(keepRef.current &&
                    !(done instanceof Map) && { cut: [...done.cut].sort() }),
                });
                if (missed) {
                  missed = [];
                  swapped = true;
                }
                held.clear();
                indexedList = undefined;
                if (behindRef.current)
                  readBehind(
                    queryClient,
                    rows,
                    detailRef.current,
                    listedFrom,
                    settleRef.current
                  );
                listedFrom = 0;
              }
              continue;
            }
            if (staged) burst.push(change);
            else live.push(change);
          }
          stageBurst();

          if (live.length > 0) {
            missed?.push(...live);
            const recounted = apply(live);
            onChangeRef.current?.();
            readAgain(
              queryClient,
              live,
              detailRef.current,
              recounted && recountRef.current,
              settleRef.current
            );
          }
        });

        // The bridge dropping events is this watch failing, whatever the
        // stream itself is doing: a resync replaces the cache from a burst,
        // so events lost in it are rows that never arrive — the list is not
        // stale, it is short, and nothing polls it back while it believes it
        // is live. Same treatment as a failed stream: say so, drop the badge,
        // start polling again.
        const offLagged = await listenBridgeLag((dropped, waitMs) => {
          if (over) return;
          fail();
          // A resync missing an unknown number of its own rows is not a
          // state to swap in — committing it would delete rows that exist.
          abandonResync();
          // A read out now is truer than rows short of what was dropped.
          missed = null;
          onErrorRef.current?.(
            tRef.current("action", "eventBridgeLagged", { n: dropped })
          );
          // Nothing sends again what the bridge dropped, and this stream's
          // next event would end the failure over a list still short of it.
          // So the stream is over, and stopped rather than left sending
          // through a bridge that is behind; another lists the collection
          // whole after the wait, and the first thing that one says is what
          // ends the failure. The consumer polls until then.
          over = true;
          streamId = null;
          void commands.unsubscribeResourceWatch(id).catch(() => {});
          const relist = () => setDropped((n) => n + 1);
          if (waitMs === 0) relist();
          else again = setTimeout(relist, waitMs);
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
          listedFrom = Date.now();
          if (!over) await commands.resourceWatchSubscribed(id);
        } catch (err) {
          if (active) {
            console.error("Failed to subscribe resource watch:", err);
          }
        }
      } catch (err) {
        if (active) {
          console.error("Failed to start resource watch:", err);
          // No stream is coming, so whoever waits on one has to be told.
          fail();
          onErrorRef.current?.(
            errorToShow(err) || tRef.current("action", "resourceWatchFailed")
          );
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
    // `renewals`: a watch is handed a `kube::Client` once and holds it, so a
    // background renewal leaves this one on credentials about to be refused.
  }, [enabled, subscribe, queryClient, queryKey, renewals, dropped]);

  return { resyncing };
}

const DETAIL_MS = 250;
/** The overview is the costliest read in the app: twice a second at most. */
const COUNTS_MS = 500;

/** A read asked for: when it is due, and its timer while it is still settling. */
interface Due {
  at: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const due = new WeakMap<QueryClient, Map<string, Due>>();

/**
 * Reads `queryKey` again once a burst of changes settles. A read in flight
 * may have left before the change, so it is waited for rather than cut
 * short, which under steady churn would never let one finish, and followed
 * as soon as it lands. Several watches ask for the same read at their own
 * settle, and the soonest one is kept: the Deployment's pod watch asking
 * first held Sam's chain to its quarter second after the Service's watches
 * had asked for a twentieth.
 */
export function readSoon(
  client: QueryClient,
  queryKey: QueryKey,
  settleMs: number
) {
  const pending = due.get(client) ?? new Map<string, Due>();
  due.set(client, pending);
  const id = hashKey(queryKey);
  const at = Date.now() + settleMs;
  const held = pending.get(id);
  if (held && (held.timer === null || held.at <= at)) return;
  if (held?.timer) clearTimeout(held.timer);
  const entry: Due = { at, timer: null };
  pending.set(id, entry);
  const read = () => {
    if (pending.get(id) === entry) pending.delete(id);
    // A hidden window re-reads on its way back; until then it is only stale.
    const visible = useWindowActivity.getState().visible;
    void client.invalidateQueries(
      { queryKey, refetchType: visible ? "active" : "none" },
      { cancelRefetch: false }
    );
  };
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (client.isFetching({ queryKey }) === 0) return read();
    // Followed the moment it lands: waiting a whole settle again put Sam's
    // chain a second behind the pod it named.
    const stop = client.getQueryCache().subscribe(() => {
      if (client.isFetching({ queryKey }) > 0) return;
      stop();
      setTimeout(read, 0);
    });
  }, settleMs);
}

/**
 * The panels polling a row the watch saw change, and the overview's counts
 * beside a list that grew or shrank: both lagged the list by a poll.
 */
function readAgain<T>(
  client: QueryClient,
  changes: Array<ResourceChange<T>>,
  detail: ((row: T) => readonly QueryKey[]) | undefined,
  recounted: boolean,
  settleMs: number
) {
  if (detail)
    for (const { resource } of changes) {
      if (!resource) continue;
      for (const key of detail(resource))
        if (client.getQueryState(key)) readSoon(client, key, settleMs);
    }
  if (recounted) readSoon(client, queryKeys.everyOverview(), COUNTS_MS);
}

/**
 * The panels reading a row a list has just delivered, where their read
 * answered before the list was asked for: a change between the two arrives
 * in the list and never as a change of its own. Sam's pod page, opened 0.4 s
 * before its pod went Running, said ContainerCreating with "live" for 2 s.
 */
function readBehind<T>(
  client: QueryClient,
  rows: readonly T[],
  detail: ((row: T) => readonly QueryKey[]) | undefined,
  listedFrom: number,
  settleMs: number
) {
  if (!detail) return;
  for (const row of rows)
    for (const key of detail(row)) {
      const state = client.getQueryState(key);
      if (
        state &&
        Math.max(state.dataUpdatedAt, state.errorUpdatedAt) <= listedFrom
      )
        readSoon(client, key, settleMs);
    }
}

/** Name plus namespace, which is what identifies a row in a list. */
function identify(item: Row): string {
  return `${item.namespace ?? ""}\0${item.name}`;
}

/** A row as a list identifies it. */
type Row = { name: string; namespace?: string | null };

/** A cached row and where it was last found in its list: a hint, checked before it is used. */
interface Slot<T> {
  row: T;
  at: number;
}

/** A list kept in its own order as it arrives: its rows, where each is, and the classes that lost rows to `keep`. */
interface Ledger<T> {
  rows: T[];
  held: Map<string, Slot<T>>;
  cut: Set<string>;
}

const ledger = <T>(): Ledger<T> => ({
  rows: [],
  held: new Map(),
  cut: new Set(),
});

function stage<T extends Row>(
  staged: Map<string, T> | Ledger<T>,
  changes: Array<ResourceChange<T>>,
  order: ((a: T, b: T) => boolean) | undefined,
  keep: Keep<T> | undefined
) {
  if (!(staged instanceof Map)) {
    staged.rows = applyChanges(
      staged.rows,
      changes,
      staged.held,
      order,
      keep,
      staged.cut
    );
    return;
  }
  for (const change of changes) {
    const incoming = change.resource;
    if (!incoming) continue;
    if (change.op === "deleted") staged.delete(identify(incoming));
    else staged.set(identify(incoming), incoming);
  }
}

/** The order a list arrives in: by namespace, then by name, as the API keys it. */
function before<T extends Row>(a: T, b: T): boolean {
  const left = a.namespace ?? "";
  const right = b.namespace ?? "";
  return left === right ? a.name < b.name : left < right;
}

/** Where a new row goes in a list kept in `order`, found in O(log N) reads. */
function sortedIndex<T>(
  rows: T[],
  row: T,
  order: (a: T, b: T) => boolean
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (order(rows[middle], row)) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Where the row under `key` is in `list`: its hint, else its sorted place,
 * else a scan. Told by its key, since a cache that shares structure hands
 * back a copy of the row it was given.
 */
function locate<T extends Row>(
  list: T[],
  key: string,
  slot: Slot<T>,
  place: (a: T, b: T) => boolean
): number {
  const there = (at: number) =>
    at >= 0 && at < list.length && identify(list[at]) === key;
  if (!there(slot.at)) {
    const at = sortedIndex(list, slot.row, place);
    slot.at = there(at) ? at : list.findIndex((row) => identify(row) === key);
  }
  if (slot.at >= 0) slot.row = list[slot.at];
  return slot.at;
}

/** `rows` without what is past `keep` in each class; what goes is forgotten and its class noted. */
function trimmed<T extends Row>(
  rows: T[],
  held: Map<string, Slot<T>>,
  keep: Keep<T>,
  lost: Set<string> | undefined
): T[] {
  if (rows.length <= keep.rows) return rows;
  const counts = new Map<string, number>();
  let kept: T[] | undefined;
  rows.forEach((row, at) => {
    const of = keep.of(row);
    const nth = (counts.get(of) ?? 0) + 1;
    counts.set(of, nth);
    if (nth <= keep.rows) {
      kept?.push(row);
      return;
    }
    kept ??= rows.slice(0, at);
    held.delete(identify(row));
    lost?.add(of);
  });
  return kept ?? rows;
}

/**
 * `list` after `changes`. Each row touched is found through `held`, which is
 * written once per row touched and never per row of the list; an insert, a
 * delete or a move then costs one copy of the array for the whole batch. A
 * new row goes where the list would have put it, not at the end, and a row
 * whose change moves it in a list of its own order leaves its old place.
 */
export function applyChanges<T extends Row>(
  list: T[],
  changes: Array<ResourceChange<T>>,
  held: Map<string, Slot<T>>,
  order?: (a: T, b: T) => boolean,
  keep?: Keep<T>,
  lost?: Set<string>
): T[] {
  const place = order ?? before;
  // The last change to a row is the one that stands.
  const finals = new Map<string, T | null>();
  for (const { op, resource } of changes)
    if (resource)
      finals.set(identify(resource), op === "deleted" ? null : resource);

  let next: T[] | undefined;
  const leaving: number[] = [];
  const arriving: Array<Slot<T>> = [];
  for (const [key, row] of finals) {
    const slot = held.get(key);
    const at = slot ? locate(list, key, slot, place) : -1;
    if (!slot || at < 0) {
      if (row) {
        const fresh = { row, at: -1 };
        held.set(key, fresh);
        arriving.push(fresh);
      } else held.delete(key);
      continue;
    }
    if (row === slot.row) continue;
    if (row === null) {
      held.delete(key);
      leaving.push(at);
      continue;
    }
    const moved = order && (order(slot.row, row) || order(row, slot.row));
    slot.row = row;
    if (moved) {
      leaving.push(at);
      arriving.push(slot);
    } else {
      next ??= list.slice();
      next[at] = row;
    }
  }
  if (leaving.length === 0 && arriving.length === 0) return next ?? list;

  const from = next ?? list;
  // The batch's own rows are put in order, never the list.
  if (leaving.length > 1) leaving.sort((a, b) => a - b);
  const coming = arriving.map((slot) => ({
    slot,
    before: sortedIndex(list, slot.row, place),
  }));
  if (coming.length > 1)
    coming.sort(
      (a, b) => a.before - b.before || (place(a.slot.row, b.slot.row) ? -1 : 1)
    );
  const rows: T[] = [];
  let gone = 0;
  let come = 0;
  for (let at = 0; at <= from.length; at++) {
    for (; come < coming.length && coming[come].before === at; come++) {
      coming[come].slot.at = rows.length;
      rows.push(coming[come].slot.row);
    }
    if (at === from.length) break;
    if (leaving[gone] === at) gone++;
    else rows.push(from[at]);
  }
  return keep && arriving.length > 0 ? trimmed(rows, held, keep, lost) : rows;
}
