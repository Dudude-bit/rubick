import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import { lanesOf, upQuery, type Lane, type MonitorRow } from "./model";

export const HOUR = 3_600_000;
export const STEP = 60_000;

export interface Heartbeat {
  /** `null` until read, or where there is nothing to ask. */
  lanes: Lane[] | null;
  /** The window the lanes cover; `null` with them. */
  window: { from: number; to: number } | null;
  query: string | null;
  unread: string | null;
}

/**
 * The last hour of `up` for a monitor's targets, a cell per minute. Asked
 * of the connected Prometheus only for targets it already listed, so a
 * monitor with no target asks nothing and draws nothing.
 */
export function useHeartbeat(row: MonitorRow): Heartbeat {
  const context = useClusterStore((state) => state.currentContext);
  const query =
    row.scrape.state === "read" ? upQuery(row.scrape.targets) : null;
  const read = useLiveQuery({
    refresh: "resourceList",
    queryKey: [context, "prometheus", "heartbeat", query],
    enabled: query !== null,
    queryFn: async () => {
      const to = Date.now();
      const from = to - HOUR;
      try {
        const series = await commands.prometheusQueryRange(
          query!,
          from,
          to,
          STEP / 1000
        );
        return {
          from,
          to,
          lanes: lanesOf(series, from, to, STEP),
          unread: null,
        };
      } catch (error) {
        return { from, to, lanes: null, unread: normalizeTauriError(error) };
      }
    },
    staleTime: STEP,
  });
  return {
    lanes: read.data?.lanes ?? null,
    window: read.data ? { from: read.data.from, to: read.data.to } : null,
    query,
    unread: read.data?.unread ?? null,
  };
}
