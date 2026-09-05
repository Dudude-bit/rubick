/**
 * The only way anything in this app re-reads the cluster on a timer: `useQuery`
 * plus the four conditions that decide whether the timer should run at all —
 * is the surface on screen, does the window have focus, has the answer stopped
 * changing, did the reader just touch something — and the one output that keeps
 * the screen honest about it.
 *
 * A query asks for a *rate* (`refresh: "resourceList"`) rather than a number,
 * and `refetchInterval` is a lint error everywhere but this file, so the number
 * cannot be written by hand — see the `no-restricted-syntax` block in
 * `eslint.config.js`.
 *
 * Every way of arriving back at a query refetches it before the reader can read
 * it: switching to a detail tab, un-minimising, regaining focus. The whole
 * licence to stop polling rests on that, so it is not tunable — a returning
 * reader must never see a number that stopped being true while they were gone.
 *
 * A query re-reading more slowly than its rate reports `freshness.slowed`, and
 * `DataFreshness` draws "slowed" rather than "polling". A *watch* is not this:
 * a connected stream stays live at any poll rate, says so with
 * `refresh: false`, and this hook never claims "live" on its own behalf.
 *
 * @module hooks/useLiveQuery
 */

import { useEffect, useRef, useState } from "react";
import {
  useQueries,
  useQuery,
  type QueryKey,
  type RefetchOptions,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";

import {
  RECORDED,
  REFRESH_INTERVALS,
  effectiveInterval,
  type RefreshRate,
} from "@/lib/refresh";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { useWindowActivity } from "@/lib/window-activity";

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
    isLoading: parts.some((part) => part.isLoading),
    error: parts.find((part) => part.error)?.error ?? null,
    refetchers: parts.map((part) => part.refetch),
  };
}

/**
 * The same discipline for a question that is several requests at once.
 *
 * A window scoped to three namespaces asks the overview three times, and
 * `useQueries` has no room for the per-query state {@link useLiveQuery}
 * keeps. It is here rather than at the call site because the interval is what
 * this module exists to own — and a fan-out is where it matters most: this is
 * the one shape in the app whose cost is multiplied by something the reader
 * chose.
 *
 * All four conditions apply, to the group rather than to a query, and two of
 * them had to be redefined.
 *
 * **Steadiness is a property of a round** — one answer from every part — and
 * not of an arrival. The parts answer in separate tasks, so counting arrivals
 * let three quiet namespaces reach `BACKOFF.steadyAfter` in the gap between
 * two answers from a fourth that was changing every poll: the interval
 * flipped between its rate and twice its rate once a second, and the badge
 * over data that was moving the whole time flipped with it. A round is steady
 * only when *all* of it comes back identical, so one part still moving keeps
 * the whole group at full rate. The overview never goes steady as its payload
 * stands — node CPU differs on every read — but the events feed does, and an
 * idle events page fanned out across four namespaces at one second is exactly
 * the bill `lib/refresh.ts` exists to stop.
 *
 * **Coming back re-reads the parts from here** rather than leaving each of
 * them to it. A fan-out is the one shape with a reason to switch React
 * Query's own focus refetch off — four namespaces re-read on every alt-tab is
 * four times the cost of the thing being avoided — and the events feed does
 * exactly that. The promise at the top of this module is the group's all the
 * same: a returning reader never reads a number that stopped being true while
 * they were away.
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
  const [steadyRuns, setSteadyRuns] = useState(0);
  const everyMs = effectiveInterval(base, {
    visible,
    focused,
    steadyRuns,
    recording: false,
  });

  const { data, stamps, settled, isLoading, error, refetchers } = useQueries({
    queries: options.queries.map((query) => ({
      ...query,
      refetchInterval: everyMs,
    })),
    combine: joinParts,
  });

  // The join is only as fresh as its stalest part: reporting the newest would
  // put a time on screen that one of the numbers under it predates. A part
  // that has never answered has no time to contribute, and a group where none
  // of them has is what `0` means everywhere else in this file.
  const answered = stamps.filter((at) => at > 0);
  const oldest = answered.length > 0 ? Math.min(...answered) : 0;

  // How many rounds in a row came back identical, a round being one answer
  // from every part. `data` is React Query's own "deep-equal to the last one"
  // per part, held still by `joinParts`, so one reference comparison is an
  // exact "no part of this group changed".
  const round = useRef<{ settled: number[]; data: Array<T | undefined> }>({
    settled: [],
    data: [],
  });
  useEffect(() => {
    const last = round.current;
    const resized = settled.length !== last.settled.length;
    const complete =
      settled.length > 0 &&
      settled.every(
        (at, index) => at > 0 && (resized || at > last.settled[index])
      );
    if (!complete) return;
    const identical = !resized && data === last.data;
    round.current = { settled, data };
    setSteadyRuns((runs) => (identical ? runs + 1 : 0));
  }, [settled, data]);

  // Coming back. Both transitions refetch, and they are separate transitions:
  // a window can become visible without taking focus, and can take focus
  // without ever having been hidden.
  const wasVisible = useRef(visible);
  const wasFocused = useRef(focused);
  useEffect(() => {
    const returned =
      (visible && !wasVisible.current) || (focused && !wasFocused.current);
    wasVisible.current = visible;
    wasFocused.current = focused;
    if (!returned) return;
    setSteadyRuns(0);
    // Nothing has ever been read here, so there is nothing stale to correct,
    // and a group held back by `enabled` has nothing to correct either —
    // `refetch` would go around the gate that is holding it.
    if (oldest === 0 || !enabled) return;
    // `cancelRefetch: false`: a part whose own focus refetch is already in
    // flight joins it instead of being restarted, which is the difference
    // between one wave of requests and two on a group of four.
    for (const refetch of refetchers) void refetch({ cancelRefetch: false });
  }, [visible, focused, enabled, oldest, refetchers]);

  // The reader touching the window retires whatever a still screen had
  // concluded. Subscribed imperatively rather than selected: an interaction
  // must not re-render every query in the app, only wake the ones that had
  // gone quiet.
  const group = useRef<{
    steadyRuns: number;
    base: number | false;
    enabled: boolean;
    oldest: number;
    refetchers: Array<(options?: RefetchOptions) => Promise<unknown>>;
  }>({ steadyRuns, base, enabled, oldest, refetchers });
  useEffect(() => {
    group.current = { steadyRuns, base, enabled, oldest, refetchers };
  }, [steadyRuns, base, enabled, oldest, refetchers]);
  useEffect(
    () =>
      useWindowActivity.subscribe((state, previous) => {
        if (state.interactionAt === previous.interactionAt) return;
        const woken = group.current;
        if (woken.steadyRuns === 0) return;
        setSteadyRuns(0);
        if (!woken.enabled || woken.base === false) return;
        // Only if the answer on screen is already older than the rate the
        // reader would expect of it. Otherwise a reader scrolling a page would
        // refetch every query on it once a second.
        if (Date.now() - woken.oldest <= woken.base) return;
        for (const refetch of woken.refetchers)
          void refetch({ cancelRefetch: false });
      }),
    []
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
    },
  };
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
  const [steadyRuns, setSteadyRuns] = useState(0);
  const everyMs = effectiveInterval(base, {
    visible,
    focused,
    steadyRuns,
    recording,
  });

  const query = useQuery({
    ...queryOptions,
    refetchInterval: everyMs,
  });

  const { dataUpdatedAt, data, refetch } = query;

  // How many answers in a row came back identical.
  //
  // React Query's structural sharing hands back the *same object* when a
  // response deep-equals the last one, so a reference comparison is an exact
  // "nothing changed" — no hashing, no second copy of the payload.
  const seenAt = useRef(0);
  const seenData = useRef<TData | undefined>(undefined);
  useEffect(() => {
    if (!dataUpdatedAt || dataUpdatedAt === seenAt.current) return;
    const identical = seenAt.current !== 0 && data === seenData.current;
    seenAt.current = dataUpdatedAt;
    seenData.current = data;
    setSteadyRuns((runs) => (identical ? runs + 1 : 0));
  }, [dataUpdatedAt, data]);

  // Coming back. Both transitions refetch, and they are separate transitions:
  // a window can become visible without taking focus, and can take focus
  // without ever having been hidden.
  const wasVisible = useRef(visible);
  const wasFocused = useRef(focused);
  useEffect(() => {
    const returned =
      (visible && !wasVisible.current) || (focused && !wasFocused.current);
    wasVisible.current = visible;
    wasFocused.current = focused;
    if (!returned) return;
    setSteadyRuns(0);
    // Nothing has ever been read here, so there is nothing stale to correct
    // and the query's own mount fetch is already on its way. A query held back
    // by `enabled` has nothing to correct either, and `refetch` would go around
    // the gate that is holding it.
    if (seenAt.current === 0 || !enabled) return;
    void refetch();
  }, [visible, focused, enabled, refetch]);

  // The reader touching the window retires whatever a still screen had
  // concluded. Subscribed imperatively rather than selected: an interaction
  // must not re-render every query in the app, only wake the ones that had
  // gone quiet.
  const steadyRef = useRef(steadyRuns);
  const baseRef = useRef<number | false>(base);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    steadyRef.current = steadyRuns;
    baseRef.current = base;
    enabledRef.current = enabled;
  }, [steadyRuns, base, enabled]);
  useEffect(
    () =>
      useWindowActivity.subscribe((state, previous) => {
        if (state.interactionAt === previous.interactionAt) return;
        if (steadyRef.current === 0) return;
        setSteadyRuns(0);
        if (!enabledRef.current) return;
        const rate = baseRef.current;
        // Only if the answer on screen is already older than the rate the
        // reader would expect of it. Otherwise a reader scrolling a page would
        // refetch every query on it once a second.
        if (rate !== false && Date.now() - seenAt.current > rate)
          void refetch();
      }),
    [refetch]
  );

  const freshness: Freshness = {
    dataUpdatedAt,
    slowed: base !== false && everyMs !== false && everyMs > base,
    paused: base !== false && everyMs === false,
    everyMs,
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
