/**
 * The only way anything here re-reads the cluster on a timer: `useQuery` plus
 * the four conditions that decide whether the timer runs at all — surface on
 * screen, window focused, answer still changing, reader recently active — and
 * the one output that keeps the screen honest about it.
 *
 * A query asks for a *rate* (`refresh: "resourceList"`), never a number:
 * `refetchInterval` is a lint error everywhere but this file — see the
 * `no-restricted-syntax` block in `eslint.config.js`.
 *
 * Every way of arriving back at a query refetches it first — switching to a
 * detail tab, un-minimising, regaining focus. The licence to stop polling
 * rests on that promise, so it is not tunable: a returning reader must never
 * see a number that stopped being true while they were gone.
 *
 * A query re-reading more slowly than its rate reports `freshness.slowed`, and
 * `DataFreshness` draws "slowed" rather than "polling". A *watch* is not this:
 * a connected stream stays live at any poll rate, says so with
 * `refresh: false`, and this hook never claims "live" on its own behalf.
 *
 * @module hooks/useLiveQuery
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useQueries,
  useQuery,
  type QueryKey,
  type RefetchOptions,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";

import {
  BACKOFF,
  RECORDED,
  REFRESH_INTERVALS,
  effectiveInterval,
  type RefreshRate,
} from "@/lib/refresh";
import { ERROR_CODES, errorCode, isRefusal } from "@/lib/error-utils";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { useWindowActivity } from "@/lib/window-activity";

/** Past this many identical answers the interval is at its cap, so counting on only draws again. */
const MAX_RUNS = BACKOFF.steadyAfter + 6;

/**
 * Identical answers in a row. The ref runs ahead of the state, so a touch and
 * an answer landing in one render count from the same number, and the state
 * is written only on a change, so a poll that answers the same at the cap
 * draws nothing.
 */
function useSteadyRuns() {
  const [steadyRuns, setSteadyRuns] = useState(0);
  const runs = useRef(0);
  const countRuns = useCallback((next: number) => {
    if (next === runs.current) return;
    runs.current = next;
    setSteadyRuns(next);
  }, []);
  const countAnswer = useCallback(
    (identical: boolean) =>
      countRuns(identical ? Math.min(runs.current + 1, MAX_RUNS) : 0),
    [countRuns]
  );
  return { steadyRuns, runs, countRuns, countAnswer };
}

export interface Freshness {
  /** React Query's own stamp: when the cluster last answered. */
  dataUpdatedAt: number;
  /**
   * Being re-read, but slower than its rate — the screen is behind what the
   * badge above it would otherwise imply.
   */
  slowed: boolean;
  /** Not being re-read at all, because the surface is off screen. */
  paused: boolean;
  /** What it is actually re-reading at, for anything that wants to say so. */
  everyMs: number | false;
  /** The last read failed, and what is on screen is from the one before it. */
  stale: boolean;
  /** Why the last read failed, or `null` where it answered. */
  failure: unknown;
  /**
   * When a read with nothing yet to show began, or `null` once something is
   * on screen. A skeleton that knows how long it has been one can say so,
   * and say what would make the wait shorter.
   */
  waitingSince: number | null;
}

export type LiveQueryOptions<
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
> = Omit<
  UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  "refetchInterval" | "refetchIntervalInBackground"
> & {
  /**
   * Which rate in {@link REFRESH_INTERVALS} this re-reads at, or `false` for a
   * query a watch stream keeps up to date.
   */
  refresh?: RefreshRate | false;
};

export type LiveQueryResult<TData, TError> = UseQueryResult<TData, TError> & {
  freshness: Freshness;
};

export interface LiveQueriesResult<T> {
  /**
   * What each part answered, in the order they were asked, and `undefined`
   * for one that has not answered yet.
   *
   * Holds its identity for as long as every answer holds its own, which is
   * what makes a `useMemo` over it worth writing: `useQueries` rebuilds its
   * result array — and a fresh tracking proxy per part — on every render, so
   * a join taken straight off that array is rebuilt on every render too,
   * including the ones this hook's own backoff causes.
   */
  data: Array<T | undefined>;
  /** Some part has nothing to show yet and is fetching it. */
  isLoading: boolean;
  /** The first part that failed: a join missing one of its parts is not one. */
  error: Error | null;
  /** Re-read every part. */
  refetch: () => void;
  /** The group's, not any one query's — see {@link useLiveQueries}. */
  freshness: Freshness;
}

interface JoinedParts<T> {
  data: Array<T | undefined>;
  /** When each part last answered, for the group's freshness. */
  stamps: number[];
  /**
   * When each part last *settled*, a failure counting as an answer.
   * `dataUpdatedAt` does not move for a failure, so a round that waited for
   * one would never complete: a scope holding a single namespace the token
   * cannot read would then poll at full rate for as long as it stayed open.
   */
  settled: number[];
  /** Which parts' latest read failed. */
  failed: boolean[];
  /** Which parts the cluster refused. */
  refused: boolean[];
  isLoading: boolean;
  error: Error | null;
  refetchers: Array<(options?: RefetchOptions) => Promise<unknown>>;
}

/**
 * Everything the group needs from its parts, in a shape that holds still.
 *
 * React Query runs a `combine` through `replaceEqualDeep`, so each field
 * below keeps its identity for as long as its value does — see
 * {@link LiveQueriesResult.data}. It is also the only place a part's fields
 * are read, which keeps React Query's per-property render tracking pointed at
 * the handful this hook actually uses.
 */
function joinParts<T>(parts: Array<UseQueryResult<T, Error>>): JoinedParts<T> {
  return {
    data: parts.map((part) => part.data),
    stamps: parts.map((part) => part.dataUpdatedAt),
    settled: parts.map((part) =>
      Math.max(part.dataUpdatedAt, part.errorUpdatedAt)
    ),
    failed: parts.map((part) => part.status === "error"),
    refused: parts.map((part) => isRefusal(part.error)),
    isLoading: parts.some((part) => part.isLoading),
    error: parts.find((part) => part.error)?.error ?? null,
    refetchers: parts.map((part) => part.refetch),
  };
}

/**
 * The same discipline for a question that is several requests at once.
 *
 * A window scoped to three namespaces asks the events feed three times, and
 * `useQueries` has no room for the per-query state {@link useLiveQuery} keeps.
 * It lives here rather than at the call site because the interval is what this
 * module owns, and a fan-out is the one shape in the app whose cost is
 * multiplied by something the reader chose.
 *
 * All four conditions apply to the group rather than to a query, and two of
 * them mean something different for it.
 *
 * **Steadiness is a property of a round** — one answer from every part — not
 * of an arrival. The parts answer in separate tasks, so counting arrivals lets
 * quiet ones reach `BACKOFF.steadyAfter` in the gap between two answers from a
 * part that is changing every poll, and the interval — with the badge over
 * data that never stopped moving — flips once a second. One part still moving
 * keeps the whole group at full rate. An idle events page fanned out across
 * four namespaces at one second is exactly the bill `lib/refresh.ts` exists
 * to stop.
 *
 * **Coming back re-reads the parts from here** rather than leaving each of
 * them to it: a fan-out is the one shape with a reason to switch React Query's
 * own focus refetch off — four namespaces re-read on every alt-tab is four
 * times the cost of the thing being avoided — and the events feed does exactly
 * that. The promise at the top of this module is the group's all the same.
 */
export function useLiveQueries<T>(options: {
  queries: Array<
    Omit<
      UseQueryOptions<T, Error>,
      "refetchInterval" | "refetchIntervalInBackground"
    >
  >;
  refresh: RefreshRate | false;
}): LiveQueriesResult<T> {
  const surfaceVisible = useSurfaceVisible();
  const windowVisible = useWindowActivity((s) => s.visible);
  const focused = useWindowActivity((s) => s.focused);
  const visible = surfaceVisible && windowVisible;
  const enabled = options.queries.every((query) => query.enabled !== false);

  const base =
    options.refresh === false ? false : REFRESH_INTERVALS[options.refresh];
  const { steadyRuns, runs, countRuns, countAnswer } = useSteadyRuns();
  const everyMs = effectiveInterval(base, {
    visible,
    focused,
    steadyRuns,
    recording: false,
  });

  const {
    data,
    stamps,
    settled,
    failed,
    refused,
    isLoading,
    error,
    refetchers,
  } = useQueries({
    queries: options.queries.map((query) => ({
      ...query,
      enabled: surfaceVisible ? query.enabled : false,
      refetchInterval: everyMs,
    })),
    combine: joinParts,
  });
  const waitingSince = useWaitingSince(isLoading);

  // The join is only as fresh as its stalest part: reporting the newest would
  // put a time on screen that one of the numbers under it predates. A part
  // that has never answered has no time to contribute, and a group where none
  // of them has is what `0` means everywhere else in this file.
  const answered = stamps.filter((at) => at > 0);
  const oldest = answered.length > 0 ? Math.min(...answered) : 0;

  // How many rounds in a row came back identical, a round being one answer
  // from every part. `data` is React Query's own "deep-equal to the last one"
  // per part, held still by `joinParts`, so one reference comparison is an
  // exact "no part of this group changed". A part answering after a failure
  // with what it said before the failure has changed all the same.
  const round = useRef<{
    settled: number[];
    data: Array<T | undefined>;
    failed: boolean[];
  }>({ settled: [], data: [], failed: [] });
  useEffect(() => {
    const last = round.current;
    const resized = settled.length !== last.settled.length;
    const complete =
      settled.length > 0 &&
      settled.every(
        (at, index) => at > 0 && (resized || at > last.settled[index])
      );
    if (!complete) return;
    const identical =
      !resized &&
      data === last.data &&
      failed.every((part, index) => part === last.failed[index]);
    round.current = { settled, data, failed };
    countAnswer(identical);
  }, [settled, data, failed, countAnswer]);

  // Coming back. Both transitions refetch, and they are separate transitions:
  // a window can become visible without taking focus, and can take focus
  // without ever having been hidden.
  const wasVisible = useRef(visible);
  const wasFocused = useRef(focused);
  useEffect(() => {
    const returned =
      visible && (!wasVisible.current || (focused && !wasFocused.current));
    wasVisible.current = visible;
    wasFocused.current = focused;
    if (!returned) return;
    countRuns(0);
    // Nothing has ever been read here, so there is nothing stale to correct,
    // and a group held back by `enabled` has nothing to correct either —
    // `refetch` would go around the gate that is holding it.
    if (oldest === 0 || !enabled) return;
    // `cancelRefetch: false`: a part whose own focus refetch is already in
    // flight joins it instead of being restarted, which is the difference
    // between one wave of requests and two on a group of four.
    refetchers.forEach((refetch, index) => {
      if (!refused[index]) void refetch({ cancelRefetch: false });
    });
  }, [visible, focused, enabled, oldest, refetchers, refused, countRuns]);

  // The reader touching the window retires whatever a still screen had
  // concluded. Subscribed imperatively rather than selected: an interaction
  // must not re-render every query in the app, only wake the ones that had
  // gone quiet.
  const group = useRef<{
    base: number | false;
    enabled: boolean;
    oldest: number;
    refetchers: Array<(options?: RefetchOptions) => Promise<unknown>>;
    failed: boolean[];
  }>({ base, enabled, oldest, refetchers, failed });
  useEffect(() => {
    group.current = {
      base,
      enabled: enabled && surfaceVisible,
      oldest,
      refetchers,
      failed,
    };
  }, [base, enabled, surfaceVisible, oldest, refetchers, failed]);
  useEffect(
    () =>
      useWindowActivity.subscribe((state, previous) => {
        if (state.interactionAt === previous.interactionAt) return;
        const woken = group.current;
        if (runs.current === 0 || woken.failed.every(Boolean)) return;
        countRuns(0);
        if (!woken.enabled || woken.base === false) return;
        // Only if the answer on screen is already older than the rate the
        // reader would expect of it. Otherwise a reader scrolling a page would
        // refetch every query on it once a second.
        if (Date.now() - woken.oldest <= woken.base) return;
        woken.refetchers.forEach((refetch, index) => {
          if (!woken.failed[index]) void refetch({ cancelRefetch: false });
        });
      }),
    [runs, countRuns]
  );

  return {
    data,
    isLoading,
    error,
    refetch: () => {
      for (const refetch of refetchers) void refetch();
    },
    freshness: {
      dataUpdatedAt: oldest,
      slowed: base !== false && everyMs !== false && everyMs > base,
      paused: base !== false && everyMs === false,
      everyMs,
      waitingSince,
      // A part that never answered is unread, not old.
      stale: failed.some(Boolean) && data.every((part) => part !== undefined),
      failure: error,
    },
  };
}

/**
 * The moment a read with nothing to show began, held until it ends.
 *
 * State, because a surface says "still reading" off it and has to render
 * when it appears; set from an effect, because `Date.now()` in render is
 * impure and would move on every re-render for no reason a reader can see.
 * The effect only writes on the transition, the same shape `setSteadyRuns`
 * above takes, so nothing cascades.
 */
function useWaitingSince(waiting: boolean): number | null {
  const [since, setSince] = useState<number | null>(null);
  const was = useRef(false);
  useEffect(() => {
    if (was.current === waiting) return;
    was.current = waiting;
    setSince(waiting ? Date.now() : null);
  }, [waiting]);
  return since;
}

export function useLiveQuery<
  TQueryFnData = unknown,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: LiveQueryOptions<TQueryFnData, TError, TData, TQueryKey>
): LiveQueryResult<TData, TError> {
  const { refresh = "resourceList", ...queryOptions } = options;
  const base = refresh === false ? false : REFRESH_INTERVALS[refresh];
  const enabled = queryOptions.enabled !== false;

  const surfaceVisible = useSurfaceVisible();
  const windowVisible = useWindowActivity((s) => s.visible);
  const focused = useWindowActivity((s) => s.focused);
  const visible = surfaceVisible && windowVisible;

  const recording = refresh !== false && RECORDED.has(refresh);
  const { steadyRuns, runs, countRuns, countAnswer } = useSteadyRuns();
  const [gone, setGone] = useState(false);
  const goneRef = useRef(false);
  const markGone = useCallback((now: boolean) => {
    if (now === goneRef.current) return;
    goneRef.current = now;
    setGone(now);
  }, []);
  const everyMs = gone
    ? false
    : effectiveInterval(base, {
        visible,
        focused,
        steadyRuns,
        recording,
      });

  // Off screen is disabled, not only unpolled: an enabled observer is still
  // "active", so a reconnect's invalidation, a cluster switch's eviction and
  // React Query's own triggers read it for a surface nobody can see.
  const query = useQuery({
    ...queryOptions,
    enabled: surfaceVisible ? queryOptions.enabled : false,
    refetchInterval: everyMs,
  });

  const {
    dataUpdatedAt,
    errorUpdatedAt,
    data,
    error,
    refetch,
    isLoading,
    status,
  } = query;
  // A failure is an answer too. Counting only `dataUpdatedAt` kept a refused
  // read at full rate for as long as its page stayed open, one 403 every
  // two seconds; `useLiveQueries` already counts it the same way.
  const settledAt = Math.max(dataUpdatedAt, errorUpdatedAt);
  // `isLoading` is already "fetching with nothing to show". Reading
  // `fetchStatus` as well drew every page once more at the start of each poll.
  const waitingSince = useWaitingSince(isLoading);

  // How many answers in a row came back identical.
  //
  // React Query's structural sharing hands back the *same object* when a
  // response deep-equals the last one, so a reference comparison is an exact
  // "nothing changed" — no hashing, no second copy of the payload. A failure
  // keeps the last data, so the outcome is compared too: an answer after a
  // refusal is a change even where it repeats the one before the refusal.
  const failed = status === "error";
  // The object is gone, and asking again every few seconds only logs it
  // again. A mount or an explicit refetch still asks.
  const notFound = failed && errorCode(error) === ERROR_CODES.NOT_FOUND;
  // The refusal memory answers a refused read until the next connect, so a
  // touch or a return that asks again changes nothing but puts a read with
  // no data back to loading: the button under the pointer is gone before its
  // click lands. The timer still asks, so a new connection notices a grant.
  const refused = failed && isRefusal(error);
  const seenAt = useRef(0);
  const seenData = useRef<TData | undefined>(undefined);
  const seenFailed = useRef(false);
  useEffect(() => {
    if (!settledAt || settledAt === seenAt.current) return;
    const identical =
      seenAt.current !== 0 &&
      data === seenData.current &&
      failed === seenFailed.current;
    seenAt.current = settledAt;
    seenData.current = data;
    seenFailed.current = failed;
    countAnswer(identical);
    markGone(notFound);
  }, [settledAt, data, failed, notFound, countAnswer, markGone]);

  // Coming back. Both transitions refetch, and they are separate transitions:
  // a window can become visible without taking focus, and can take focus
  // without ever having been hidden.
  const wasVisible = useRef(visible);
  const wasFocused = useRef(focused);
  useEffect(() => {
    const returned =
      visible && (!wasVisible.current || (focused && !wasFocused.current));
    wasVisible.current = visible;
    wasFocused.current = focused;
    if (!returned) return;
    countRuns(0);
    // Nothing has ever been read here, so there is nothing stale to correct
    // and the query's own mount fetch is already on its way. A query held back
    // by `enabled` has nothing to correct either, and `refetch` would go around
    // the gate that is holding it.
    if (seenAt.current === 0 || !enabled || gone || refused) return;
    // Joins the read a re-enabled observer has already started.
    void refetch({ cancelRefetch: false });
  }, [visible, focused, enabled, gone, refused, refetch, countRuns]);

  // The reader touching the window retires whatever a still screen had
  // concluded. Subscribed imperatively rather than selected: an interaction
  // must not re-render every query in the app, only wake the ones that had
  // gone quiet.
  const baseRef = useRef<number | false>(base);
  const enabledRef = useRef(enabled);
  const failedRef = useRef(failed);
  useEffect(() => {
    baseRef.current = base;
    failedRef.current = failed;
    enabledRef.current = enabled && surfaceVisible && !gone && !refused;
  }, [base, failed, enabled, surfaceVisible, gone, refused]);
  useEffect(
    () =>
      useWindowActivity.subscribe((state, previous) => {
        if (state.interactionAt === previous.interactionAt) return;
        // A read that keeps failing is not a still screen: waking it on every
        // touch asked a cluster that was down every two seconds for as long
        // as the pointer moved. The timer and Retry still ask.
        if (runs.current === 0 || failedRef.current) return;
        countRuns(0);
        if (!enabledRef.current) return;
        const rate = baseRef.current;
        // Only if the answer on screen is already older than the rate the
        // reader would expect of it. Otherwise a reader scrolling a page would
        // refetch every query on it once a second.
        if (rate !== false && Date.now() - seenAt.current > rate)
          void refetch();
      }),
    [refetch, runs, countRuns]
  );

  const freshness: Freshness = {
    dataUpdatedAt,
    slowed: base !== false && everyMs !== false && everyMs > base,
    paused: base !== false && everyMs === false,
    everyMs,
    waitingSince,
    stale: failed && data !== undefined,
    failure: failed ? error : null,
  };

  // Neither spread nor assigned. React Query hands back a proxy that records
  // which fields the caller read and re-renders only for those: spreading
  // reads all of them and turns that off for every screen in the app, and
  // writing onto it adds a key to the observer's own result object, which is
  // shallow-compared against the next one — every update would then look like
  // a change. A child object leaves both alone: `freshness` is the only own
  // property, and everything else resolves through the proxy exactly as
  // before.
  return Object.create(query, {
    freshness: { value: freshness, enumerable: true },
  }) as LiveQueryResult<TData, TError>;
}
