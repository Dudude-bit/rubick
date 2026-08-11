/**
 * The only way anything in this app re-reads the cluster on a timer.
 *
 * `useQuery` plus the four conditions that decide whether the timer should run
 * at all — is the surface on screen, does the window have focus, has the
 * answer stopped changing, did the reader just touch something — and the one
 * output that keeps the screen honest about it.
 *
 * Two things make this a mechanism rather than a helper. A query written
 * tomorrow inherits all of it by asking for a *rate* (`refresh: "resourceList"`)
 * instead of a number, and `refetchInterval` is a lint error everywhere except
 * this file, so the number cannot be written by hand again. See the
 * `no-restricted-syntax` block in `eslint.config.js`.
 *
 * ## Coming back
 *
 * Every way of arriving back at a query refetches it before the reader can
 * read it: a detail tab being switched to, the window being un-minimised, the
 * window regaining focus. This is not an optimisation to be tuned away — the
 * whole licence to stop polling rests on it. A returning reader must never see
 * a number that stopped being true while they were gone.
 *
 * ## What it says about itself
 *
 * A query re-reading more slowly than its rate reports `freshness.slowed`, and
 * `DataFreshness` draws "slowed" rather than "polling" for it. A *watch* is not
 * this: a stream that is still connected keeps its data live at any poll rate,
 * says so with `refresh: false`, and this hook never claims "live" on its own
 * behalf — that word belongs to the surface that owns the stream.
 *
 * @module hooks/useLiveQuery
 */

import { useEffect, useRef, useState } from "react";
import {
  useQuery,
  type QueryKey,
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
