/**
 * Feeds one object's polls into its ring buffer and hands back the window.
 *
 * The timestamp is the query's own `dataUpdatedAt` rather than `Date.now()`
 * so a sample is stamped with the moment the cluster answered, and so the
 * same poll reaching two mounted readers is recognised as one sample
 * instead of two. That is also why nothing here debounces: the store drops
 * a repeat timestamp on its own.
 */
import { useEffect } from "react";
import {
  seriesKey,
  useUsageHistoryStore,
  type UsageSeries,
} from "@/stores/usageHistoryStore";
import type { UsageSample } from "@/lib/usage-history";

const EMPTY: readonly UsageSample[] = [];

export interface UseUsageHistoryOptions {
  /** The object's kind, to keep two kinds' uids in separate namespaces. */
  kind: string;
  /** Identity. A pod replaced under the same name has a different uid and
   *  therefore a different, empty buffer — which is the point. */
  uid: string | null | undefined;
  cpuMillicores: number | null | undefined;
  memoryBytes: number | null | undefined;
  /** Cumulative restarts, when the caller has them; drives the markers. */
  restarts?: number | null;
  /** `dataUpdatedAt` of the metrics query that produced these numbers. */
  sampledAt: number | null | undefined;
  /** False while metrics-server is unavailable — a buffer of nulls would
   *  otherwise accumulate and later read as a gap rather than as absence. */
  enabled?: boolean;
}

export function useUsageHistory({
  kind,
  uid,
  cpuMillicores,
  memoryBytes,
  restarts,
  sampledAt,
  enabled = true,
}: UseUsageHistoryOptions): readonly UsageSample[] {
  const key = seriesKey(kind, uid);
  const record = useUsageHistoryStore((state) => state.record);
  const series: UsageSeries | undefined = useUsageHistoryStore((state) =>
    key === null ? undefined : state.series[key]
  );

  useEffect(() => {
    if (!enabled || key === null) return;
    if (!sampledAt) return;
    if (cpuMillicores == null && memoryBytes == null) return;
    record(key, {
      t: sampledAt,
      cpuMillicores: cpuMillicores ?? null,
      memoryBytes: memoryBytes ?? null,
      restarts: restarts ?? null,
    });
  }, [enabled, key, sampledAt, cpuMillicores, memoryBytes, restarts, record]);

  return series?.samples ?? EMPTY;
}
