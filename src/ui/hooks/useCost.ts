/**
 * What a scope costs, from whichever source this cluster has: a supplier
 * that prices it first, entered prices where none does. The Cost page, a
 * namespace's page and a workload's page all read through here, so each
 * says the same number and the same reason it has none.
 */
import { useCallback, useMemo } from "react";

import { useCapabilityState } from "@/integrations";
import type { CapabilityState, CostRange, CostTrend } from "@/integrations";
import { commands } from "@/lib/commands";
import {
  estimatePicture,
  pricesNoNode,
  readingPicture,
  type CostPicture,
  type Prices,
} from "@/lib/cost";
import type { UsageReading } from "@/lib/efficiency";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import type { CostBasis, WorkloadKey } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useCostPrices } from "@/stores/costPricesStore";
import { useClusterStore } from "@/stores/clusterStore";

/** Why the supplier gave no picture, said beside an estimate or alone. */
export type SupplierTrouble =
  | { kind: "noSeries"; vendor: string; endpoint: string }
  /** OpenCost answers and prices none of the nodes. */
  | { kind: "noNodePrices"; vendor: string; endpoint: string }
  | {
      kind: "unreachable";
      vendor: string;
      endpoint: string;
      said: string;
      /** The supplier's probe, to ask again from the sentence. */
      power: Extract<CapabilityState<"cost.now">, { state: "unreachable" }>;
    }
  | { kind: "failed"; vendor: string; endpoint: string; said: string };

export type CostState =
  | { state: "loading" }
  /** No supplier and no prices: the page says what either would give. */
  | { state: "nothing" }
  | { state: "supplier"; trouble: SupplierTrouble }
  | { state: "basisFailed"; error: unknown }
  | {
      state: "picture";
      picture: CostPicture;
      /** Set where this is an estimate because the supplier gave none. */
      trouble: SupplierTrouble | null;
    };

/** A short stand-in for a set of rows, so a query re-reads when they change. */
export function rowsKey(keys: readonly WorkloadKey[]): string {
  let hash = 2166136261;
  for (const key of keys) {
    const text = `${key.namespace}/${key.group}/${key.kind}/${key.name};`;
    for (let i = 0; i < text.length; i++)
      hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return `${keys.length}:${(hash >>> 0).toString(36)}`;
}

export interface CostRead {
  cost: CostState;
  basis: CostBasis | undefined;
  /** Read the basis and the supplier again. */
  retry: () => void;
}

/**
 * `namespaces` `null` is the whole cluster. `detail` leaves out the node
 * breakdown: a page about one object needs only the cluster's total for its
 * share, not a row per node.
 */
export function useCost(
  namespaces: string[] | null,
  { detail = false }: { detail?: boolean } = {}
): CostRead {
  const context = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);
  const prices = useCostPrices(context);
  const power = useCapabilityState("cost.now");
  const wanted = power.state !== "absent" || prices !== null;

  const basis = useLiveQuery({
    queryKey: queryKeys.costBasis(namespaces, !detail),
    queryFn: () => commands.costBasis(namespaces, !detail),
    enabled: isConnected && wanted,
    refresh: "steady",
  });
  const keys = useMemo(
    () => basis.data?.workloads.map((w) => w.key) ?? [],
    [basis.data]
  );
  const ready = power.state === "ready" ? power : null;
  // The basis rides with its answer: the answer is positional on the
  // basis's rows, and a newer basis beside an older answer would put one
  // workload's cost on another's row.
  const asked = basis.data;
  const reading = useLiveQuery({
    queryKey: queryKeys.costReading(namespaces, !detail, rowsKey(keys)),
    queryFn: async () => ({
      basis: asked!,
      reading: await ready!.use({ namespaces, keys, nodes: !detail }),
    }),
    enabled: ready !== null && basis.data !== undefined,
    refresh: "steady",
    retry: false,
    placeholderData: (previous) => previous,
  });

  const cost = useMemo((): CostState => {
    if (power.state === "reading") return { state: "loading" };
    if (!wanted) return { state: "nothing" };
    if (!basis.data) {
      if (basis.error) return { state: "basisFailed", error: basis.error };
      return { state: "loading" };
    }
    let trouble: SupplierTrouble | null = null;
    if (power.state === "unreachable")
      trouble = {
        kind: "unreachable",
        vendor: power.vendor,
        endpoint: power.endpoint,
        said: power.reason,
        power,
      };
    if (power.state === "ready") {
      // OpenCost found no price list for any node (kind, or a provider it
      // has none for): entered prices fill that in, saying why.
      if (reading.data?.reading && prices && pricesNoNode(reading.data.reading))
        return {
          state: "picture",
          picture: estimatePicture(basis.data, prices, namespaces),
          trouble: {
            kind: "noNodePrices",
            vendor: power.vendor,
            endpoint: power.endpoint,
          },
        };
      if (reading.data?.reading)
        return {
          state: "picture",
          picture: readingPicture(
            reading.data.basis,
            reading.data.reading,
            {
              kind: "opencost",
              vendor: power.vendor,
              endpoint: power.endpoint,
            },
            namespaces
          ),
          trouble: null,
        };
      if (reading.error)
        trouble = {
          kind: "failed",
          vendor: power.vendor,
          endpoint: power.endpoint,
          said: errorToShow(reading.error),
        };
      else if (reading.data && reading.data.reading === null)
        trouble = {
          kind: "noSeries",
          vendor: power.vendor,
          endpoint: power.endpoint,
        };
      else return { state: "loading" };
    }
    if (prices)
      return {
        state: "picture",
        picture: estimatePicture(basis.data, prices, namespaces),
        trouble,
      };
    return trouble ? { state: "supplier", trouble } : { state: "nothing" };
  }, [
    power,
    wanted,
    basis.data,
    basis.error,
    reading.data,
    reading.error,
    prices,
    namespaces,
  ]);

  const refetchBasis = basis.refetch;
  const refetchReading = reading.refetch;
  const retry = useCallback(() => {
    void refetchBasis();
    void refetchReading();
  }, [refetchBasis, refetchReading]);
  return { cost, basis: basis.data, retry };
}

/**
 * Every workload's use over a day, apart from cost: the subqueries behind it
 * can be slow on a large cluster, and the cost numbers do not wait for them.
 */
export function useWorkloadUsage(
  namespaces: string[] | null,
  keys: readonly WorkloadKey[] | null
): UsageReading & { since?: number | null } {
  const power = useCapabilityState("usage.workloads");
  const ready = power.state === "ready" ? power : null;
  const rows = keys ? rowsKey(keys) : "";
  const usage = useLiveQuery({
    queryKey: queryKeys.workloadUsage(namespaces, rows),
    queryFn: async () => {
      const asked = [...(keys ?? [])];
      return {
        keys: asked,
        fold: await ready!.use({ namespaces, keys: asked }),
      };
    },
    enabled: ready !== null && keys !== null && keys.length > 0,
    // A day's window barely moves between two reads.
    refresh: "steady",
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
  const since = usage.freshness.waitingSince;
  return useMemo(() => {
    if (power.state === "absent") return { state: "noSupplier" };
    if (power.state === "reading") return { state: "reading", since: null };
    if (power.state === "unreachable")
      return { state: "failed", said: power.reason };
    if (usage.data)
      return { state: "read", keys: usage.data.keys, fold: usage.data.fold };
    if (usage.error) return { state: "failed", said: errorToShow(usage.error) };
    return { state: "reading", since };
  }, [power, usage.data, usage.error, since]);
}

export type TrendState =
  | { state: "noSupplier" }
  | { state: "reading" }
  | { state: "failed"; endpoint: string; said: string }
  | { state: "read"; trend: CostTrend; endpoint: string };

/**
 * The cost per hour over a range. `prices` `null` reads the supplier's own
 * prices; given, it is the estimate the page draws, over what the cluster
 * held then.
 */
export function useCostTrend(
  namespaces: string[] | null,
  range: CostRange,
  prices: Prices | null
): TrendState {
  const power = useCapabilityState("cost.history");
  const ready = power.state === "ready" ? power : null;
  const trend = useLiveQuery({
    queryKey: queryKeys.costTrend(namespaces, range, JSON.stringify(prices)),
    queryFn: () => ready!.use({ namespaces, range, prices }),
    enabled: ready !== null,
    refresh: "steady",
    staleTime: 60_000,
    retry: false,
  });
  return useMemo((): TrendState => {
    if (power.state === "absent") return { state: "noSupplier" };
    if (power.state === "reading") return { state: "reading" };
    if (power.state === "unreachable")
      return { state: "failed", endpoint: power.endpoint, said: power.reason };
    if (trend.data)
      return { state: "read", trend: trend.data, endpoint: power.endpoint };
    if (trend.error)
      return {
        state: "failed",
        endpoint: power.endpoint,
        said: errorToShow(trend.error),
      };
    return { state: "reading" };
  }, [power, trend.data, trend.error]);
}
