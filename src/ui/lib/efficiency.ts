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
import type { PodsRead, WorkloadFold, WorkloadKey } from "@/generated/types";
import type { T } from "@/i18n/useT";

/** The window usage is read over, as PromQL writes it. */
export const EFFICIENCY_WINDOW = "24h";
const WINDOW_MS = 24 * 3_600_000;

const UNIT_WORDS = {
  m: "spanMinutesInSentence",
  h: "spanHours",
  d: "spanDays",
} as const;

/**
 * A window such as `24h` in the reader's words, in its own unit: "24
 * hours", «24 часа». A PromQL token is not a word of either language. One
 * not of that shape is kept as written.
 */
export function windowWords(window: string, t: T): string {
  const [, n, unit] = /^(\d+)([mhd])$/.exec(window) ?? [];
  return n && unit
    ? t("readings", UNIT_WORDS[unit as keyof typeof UNIT_WORDS], {
        n: Number(n),
      })
    : window;
}

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
  | {
      state: "read";
      keys: readonly WorkloadKey[];
      fold: WorkloadFold;
      /** When it was read: what it covers is judged then, not at render. */
      at?: number | null;
    };

export type Efficiency =
  /** Nothing keeps usage history for this cluster. */
  | { state: "noSupplier" }
  | { state: "reading" }
  | { state: "failed"; said: string }
  /** The supplier answered and holds no sample of this workload's pods: young ones may have none yet. */
  | ({ state: "noSamples" } & Span)
  /** Nothing was requested, so there is no ratio: not 0%, not 100%. */
  | ({
      state: "unrequested";
      avg: number | null;
      peak: number | null;
    } & Span &
      Pods)
  | ({
      state: "measured";
      requested: number;
      avg: number | null;
      peak: number | null;
      /** Average used ÷ requested; `null` where only the peak was read. */
      ratio: number | null;
      peakRatio: number | null;
    } & Span &
      Pods);

/** Which of its pods the figures were read from. */
interface Pods {
  /**
   * Each pod's own peak, summed over every pod it runs: the workload's was
   * no higher, and may have been lower where they peaked apart.
   */
  peakAtMost: boolean;
  /**
   * The average read from `read` of the `of` pods it runs, and the peak:
   * each `null` where from every one, each counted on its own query. A sum
   * over some of them is neither its figure nor a bound on it.
   */
  avgPods: PodsRead | null;
  peakPods: PodsRead | null;
}

export type { PodsRead };

/**
 * How much of the window the readings cover. Each pod is averaged over its
 * own life, so a workload rolled out two hours ago reads two hours.
 */
interface Span {
  /** When the youngest of its pods started; `null` where not known. */
  since: string | null;
  /** Its youngest pod has run the whole window. */
  whole: boolean;
}

export interface WorkloadEfficiency {
  cpu: Efficiency;
  memory: Efficiency;
}

/** One resource of one workload, from what it requests and the two readings. */
export function efficiencyOf(
  requested: number,
  avg: number | null,
  peak: number | null,
  since: string | null,
  now: number = Date.now(),
  pods: Partial<Pods> = {}
): Efficiency {
  const started = since === null ? NaN : Date.parse(since);
  const span = { since, whole: now - started >= WINDOW_MS };
  const from = {
    peakAtMost: pods.peakAtMost ?? false,
    avgPods: pods.avgPods ?? null,
    peakPods: pods.peakPods ?? null,
  };
  if (avg === null && peak === null) return { state: "noSamples", ...span };
  if (requested <= 0)
    return { state: "unrequested", avg, peak, ...from, ...span };
  return {
    state: "measured",
    requested,
    avg,
    peak,
    ratio: avg === null ? null : avg / requested,
    peakRatio: peak === null ? null : peak / requested,
    ...from,
    ...span,
  };
}

/**
 * A workload's efficiency, out of a reading of every workload's usage.
 * `requests` in millicores and bytes, as the cluster holds them now.
 */
const positions = new WeakMap<readonly WorkloadKey[], Map<string, number>>();
const idOf = (key: WorkloadKey) =>
  `${key.namespace}\n${key.group}\n${key.kind}\n${key.name}`;

/** Where `key` stands among `keys`, by an index built once per answer: 600 rows each searching 600 keys was 360 000 comparisons. */
function positionOf(keys: readonly WorkloadKey[], key: WorkloadKey): number {
  let index = positions.get(keys);
  if (!index) {
    index = new Map();
    for (const [i, each] of keys.entries())
      if (!index.has(idOf(each))) index.set(idOf(each), i);
    positions.set(keys, index);
  }
  return index.get(idOf(key)) ?? -1;
}

export function workloadEfficiency(
  reading: UsageReading,
  key: WorkloadKey,
  requests: { cpu: number; memory: number },
  asOf?: number
): WorkloadEfficiency {
  if (reading.state !== "read") return { cpu: reading, memory: reading };
  // What a reading covers is judged when it was read: a day counted at
  // render grew a few hours' reading into a whole one.
  const now = asOf ?? reading.at ?? Date.now();
  // Its namespace's pods were refused to the read: no sample is not "none".
  const refused = reading.fold.unread.find(
    (u) => u.namespace === key.namespace
  );
  if (refused) {
    const failed: Efficiency = { state: "failed", said: refused.message };
    return { cpu: failed, memory: failed };
  }
  const at = positionOf(reading.keys, key);
  const values = at === -1 ? undefined : reading.fold.values[at];
  if (!values) {
    const none: Efficiency = { state: "noSamples", since: null, whole: false };
    return { cpu: none, memory: none };
  }
  const [cpuAvg, cpuPeak, memoryAvg, memoryPeak] = values;
  const since = reading.fold.since[at] ?? null;
  const covered = reading.fold.covered[at] ?? [];
  const of = reading.fold.pods[at];
  // Each figure covers the pods its own query had a series for. A peak is
  // read per pod: summed over every one it runs it is a bound, and over
  // some of them it is neither.
  const podsOf = (
    avg: (typeof USAGE_QUERIES)[number],
    peak: (typeof USAGE_QUERIES)[number]
  ): Partial<Pods> => {
    if (of === undefined) return {};
    const some = (query: (typeof USAGE_QUERIES)[number]): PodsRead | null => {
      const at = USAGE_QUERIES.indexOf(query);
      const read = covered[at] ?? 0;
      return values[at] === null || values[at] === undefined || read >= of
        ? null
        : { read, of };
    };
    const peakPods = some(peak);
    const peakRead = covered[USAGE_QUERIES.indexOf(peak)] ?? 0;
    return {
      avgPods: some(avg),
      peakPods,
      peakAtMost: peakPods === null && peakRead > 1,
    };
  };
  return {
    cpu: efficiencyOf(
      requests.cpu,
      cpuAvg ?? null,
      cpuPeak ?? null,
      since,
      now,
      podsOf("cpuAvg", "cpuPeak")
    ),
    memory: efficiencyOf(
      requests.memory,
      memoryAvg ?? null,
      memoryPeak ?? null,
      since,
      now,
      podsOf("memoryAvg", "memoryPeak")
    ),
  };
}

/** Amber: asking far more than it used, or a read of its use that did not answer. */
export const efficiencyWarns = (efficiency: Efficiency): boolean =>
  efficiency.state === "failed" || overRequested(efficiency);

/** The share of a request a peak must stay under for the request to be far above use. */
export const OVER_REQUESTED_BELOW = 0.5;

/**
 * Asked for far more than it ever used: its peak over the whole window
 * stayed under half the request. Only a measured peak can say so, and only
 * over a whole day of its pods: a peak from the hours since a rollout has
 * not met the day's busiest hour, and only over every pod it runs. A
 * workload nobody measured, or one that requests nothing, is never judged.
 */
export function overRequested(efficiency: Efficiency): boolean {
  return (
    efficiency.state === "measured" &&
    efficiency.whole &&
    efficiency.peakPods === null &&
    efficiency.peakRatio !== null &&
    efficiency.peakRatio < OVER_REQUESTED_BELOW
  );
}
