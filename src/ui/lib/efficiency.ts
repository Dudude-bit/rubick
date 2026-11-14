/**
 * What a workload requests against what it used, over a window of history.
 *
 * The app's own definition: neither OpenCost's documentation nor its spec
 * defines efficiency. Average used ÷ requested is how much of the request
 * the workload lived in; peak ÷ requested is the most it ever reached, and
 * the one a rule about asking for too much must read, since one sample
 * flaps and a quiet average hides a spike that needed the room.
 *
 * The Cost page reads this for its efficiency column, and Audit for its
 * rule about requests far above use ({@link overRequested}).
 */
import type { WorkloadFold, WorkloadKey } from "@/generated/types";

/** The window usage is read over, worded on the column. */
export const EFFICIENCY_WINDOW = "24h";

/** The order a supplier's usage queries answer in. */
export const USAGE_QUERIES = [
  "cpuAvg",
  "cpuPeak",
  "memoryAvg",
  "memoryPeak",
] as const;

/** Where the usage came from, and whether it came. */
export type UsageReading =
  | { state: "noSupplier" }
  | { state: "reading" }
  | { state: "failed"; said: string }
  | { state: "read"; keys: readonly WorkloadKey[]; fold: WorkloadFold };

export type Efficiency =
  /** Nothing keeps usage history for this cluster. */
  | { state: "noSupplier" }
  | { state: "reading" }
  | { state: "failed"; said: string }
  /** The supplier answered and holds no sample of this workload's pods. */
  | { state: "noSamples" }
  /** Nothing was requested, so there is no ratio: not 0%, not 100%. */
  | { state: "unrequested"; avg: number | null; peak: number | null }
  | {
      state: "measured";
      requested: number;
      avg: number | null;
      peak: number | null;
      /** Average used ÷ requested; `null` where only the peak was read. */
      ratio: number | null;
      peakRatio: number | null;
    };

export interface WorkloadEfficiency {
  cpu: Efficiency;
  memory: Efficiency;
}

/** One resource of one workload, from what it requests and the two readings. */
export function efficiencyOf(
  requested: number,
  avg: number | null,
  peak: number | null
): Efficiency {
  if (avg === null && peak === null) return { state: "noSamples" };
  if (requested <= 0) return { state: "unrequested", avg, peak };
  return {
    state: "measured",
    requested,
    avg,
    peak,
    ratio: avg === null ? null : avg / requested,
    peakRatio: peak === null ? null : peak / requested,
  };
}

const sameKey = (a: WorkloadKey, b: WorkloadKey) =>
  a.namespace === b.namespace && a.kind === b.kind && a.name === b.name;

/**
 * A workload's efficiency, out of a reading of every workload's usage.
 * `requests` in millicores and bytes, as the cluster holds them now.
 */
export function workloadEfficiency(
  reading: UsageReading,
  key: WorkloadKey,
  requests: { cpu: number; memory: number }
): WorkloadEfficiency {
  if (reading.state !== "read") return { cpu: reading, memory: reading };
  const at = reading.keys.findIndex((candidate) => sameKey(candidate, key));
  const values = at === -1 ? undefined : reading.fold.values[at];
  if (!values)
    return { cpu: { state: "noSamples" }, memory: { state: "noSamples" } };
  const [cpuAvg, cpuPeak, memoryAvg, memoryPeak] = values;
  return {
    cpu: efficiencyOf(requests.cpu, cpuAvg ?? null, cpuPeak ?? null),
    memory: efficiencyOf(
      requests.memory,
      memoryAvg ?? null,
      memoryPeak ?? null
    ),
  };
}

/** The share of a request a peak must stay under for the request to be far above use. */
export const OVER_REQUESTED_BELOW = 0.5;

/**
 * Asked for far more than it ever used: its peak over the whole window
 * stayed under half the request. Only a measured peak can say so; a
 * workload nobody measured, or one that requests nothing, is never judged.
 */
export function overRequested(efficiency: Efficiency): boolean {
  return (
    efficiency.state === "measured" &&
    efficiency.peakRatio !== null &&
    efficiency.peakRatio < OVER_REQUESTED_BELOW
  );
}
