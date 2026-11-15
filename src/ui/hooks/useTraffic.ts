/**
 * Who talks to whom, from whichever supplier this cluster has. The Traffic
 * page and a workload's block both read through here, so each says the same
 * numbers and the same reason it has none; and neither asks anything of a
 * supplier that is not there or holds no source.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { WorkloadKey } from "@/generated/types";
import { useCapabilityState, type CapabilityState } from "@/integrations";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import type { RefreshRate } from "@/lib/refresh";
import {
  RowMemo,
  type FlowRow,
  type FlowSource,
  type FlowWindow,
  type TrafficReading,
} from "@/lib/traffic";
import { useLiveQuery } from "./useLiveQuery";

/**
 * How often a supplier is asked which sources it holds: they come with
 * installs, not with traffic, so rarely; but a source that could not be
 * looked for is asked again soon, or it is said failed for minutes after
 * Prometheus has answered.
 */
export const sourcesRefresh = (
  sources: readonly FlowSource[] | undefined
): RefreshRate =>
  sources?.some((source) => source.state.says === "failed")
    ? "steady"
    : "unserved";

export type TrafficState =
  | { says: "absent" }
  | { says: "checking" }
  | {
      says: "unreachable";
      /** The supplier as it did not answer, with the way to ask it again. */
      power: Extract<
        CapabilityState<"traffic.flows">,
        { state: "unreachable" }
      >;
    }
  | { says: "looking"; endpoint: string }
  | { says: "noSource"; endpoint: string; sources: readonly FlowSource[] }
  | { says: "reading"; endpoint: string; sources: readonly FlowSource[] }
  | {
      says: "failed";
      endpoint: string;
      sources: readonly FlowSource[];
      said: string;
    }
  | {
      says: "read";
      endpoint: string;
      sources: readonly FlowSource[];
      reading: TrafficReading;
      rows: readonly FlowRow[];
      /** The latest read failed; `reading` is the one before it. */
      lastFailed: string | null;
    };

export const subjectKey = (key: WorkloadKey | null) =>
  key ? `${key.namespace}/${key.group}/${key.kind}/${key.name}` : null;

export function useTraffic(input: {
  scope: string[] | null;
  window: FlowWindow;
  subject?: WorkloadKey | null;
  refresh: RefreshRate;
  enabled?: boolean;
}): TrafficState {
  const { scope, window, refresh, enabled = true } = input;
  const subject = input.subject ?? null;
  const power = useCapabilityState("traffic.flows");
  const ready = power.state === "ready" ? power : null;
  const endpoint =
    power.state === "ready" || power.state === "unreachable"
      ? power.endpoint
      : "";

  const client = useQueryClient();
  const sourcesKey = queryKeys.trafficSources(endpoint);
  const sources = useLiveQuery({
    queryKey: sourcesKey,
    queryFn: () => ready!.use.sources(),
    enabled: enabled && ready !== null,
    // The answer this hook re-renders on, read for the rate of the next ask.
    refresh: sourcesRefresh(client.getQueryData<FlowSource[]>(sourcesKey)),
    retry: false,
  });
  const present = useMemo(
    () =>
      (sources.data ?? []).filter((source) => source.state.says === "present"),
    [sources.data]
  );
  const flows = useLiveQuery({
    queryKey: queryKeys.traffic(
      scope,
      window,
      subjectKey(subject),
      present
        .map((source) => `${source.id}:${source.found.join("+")}`)
        .join(",")
    ),
    queryFn: () =>
      ready!.use.read({ scope, window, subject, sources: present }),
    enabled: enabled && ready !== null && present.length > 0,
    refresh,
    retry: false,
  });

  // What the last read drew, so a pair that did not change keeps its row.
  const [held] = useState(() => new RowMemo());
  const rows = useMemo(
    () => (flows.data ? held.rows(flows.data) : []),
    [held, flows.data]
  );

  switch (power.state) {
    case "absent":
      return { says: "absent" };
    case "reading":
      return { says: "checking" };
    case "unreachable":
      return { says: "unreachable", power };
    case "ready":
      break;
  }
  if (sources.error)
    return {
      says: "failed",
      endpoint,
      sources: [],
      said: errorToShow(sources.error),
    };
  if (!sources.data) return { says: "looking", endpoint };
  if (present.length === 0)
    return { says: "noSource", endpoint, sources: sources.data };
  if (flows.data)
    return {
      says: "read",
      endpoint,
      sources: sources.data,
      reading: flows.data,
      rows,
      lastFailed: flows.error ? errorToShow(flows.error) : null,
    };
  if (flows.error)
    return {
      says: "failed",
      endpoint,
      sources: sources.data,
      said: errorToShow(flows.error),
    };
  return { says: "reading", endpoint, sources: sources.data };
}
