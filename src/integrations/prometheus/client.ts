/**
 * Prometheus answers, turned into the shapes the app already draws.
 *
 * The HTTP is the backend's — this file sends PromQL and reads numbers, and
 * never sees the credential. What it owns is the alignment: three separate
 * range queries come back as three series over the same timestamps, and the
 * chart wants one array of samples. Doing that here keeps `usage-chart`
 * unable to tell where its samples came from, which is what makes the
 * fallback and the Prometheus answer literally the same picture.
 */

import { commands } from "@/lib/commands";
import type { PromSeries } from "@/generated/types";
import type { UsageSample } from "@/lib/usage-history";
import type {
  DeclaredHistory,
  DeclaredPoint,
  NodeUsageWindow,
  TrafficWindow,
  UsageRange,
  UsageScope,
  UsageWindow,
  VolumeFullness,
} from "../registry";
import { nodeNameOf } from "./coverage";
import {
  RANGE_SPECS,
  cpuQuery,
  declaredQuery,
  memoryQuery,
  nodesNewestQuery,
  nodesQuery,
  restartQuery,
  trafficQuery,
  volumeCapacityQuery,
  volumeUsedQuery,
} from "./queries";

/**
 * The buckets a series answered for, gaps kept as gaps.
 *
 * A bucket the supplier had nothing for stays `null` rather than vanishing
 * from the array: a dropped bucket closes the line up, and a scrape outage
 * is then drawn as a confident straight segment across the minutes nobody
 * measured. `byTime` is for the sample clock, where the union of three
 * queries decides which buckets exist; here the series is its own clock.
 */
function pointsOf(series: PromSeries[]): DeclaredPoint[] {
  const at = new Map<number, number | null>();
  for (const one of series) {
    for (const point of one.points) {
      const value = point.v ?? null;
      const seen = at.get(point.t);
      if (value === null) {
        if (seen === undefined) at.set(point.t, null);
      } else {
        at.set(point.t, (seen ?? 0) + value);
      }
    }
  }
  return [...at.keys()]
    .sort((a, b) => a - b)
    .map((t) => ({ t, v: at.get(t) ?? null }));
}

/**
 * Whether kube-state-metrics is in this Prometheus at all. Asked only when
 * the declared series came back empty, which is also what a pod with no
 * requests looks like; the difference is "nothing declared" against
 * "nobody recorded it", and the chart says which.
 */
async function keepsDeclared(): Promise<boolean | null> {
  // `null` is "could not tell", never "absent": a refused or rate-limited
  // probe used to read as `false`, and the chart then stated as fact that
  // kube-state-metrics was not installed. `coverage.ts` has always drawn
  // this distinction for the same metric; both readers now agree.
  const answer = await commands
    .prometheusQuery("count(kube_pod_container_resource_requests)")
    .catch(() => null);
  if (answer === null) return null;
  return answer.length > 0 && (answer[0].points[0]?.v ?? 0) > 0;
}

/** The one series a scoped query is expected to return, flattened by time. */
function byTime(series: PromSeries[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const one of series) {
    for (const point of one.points) {
      if (point.v === null || point.v === undefined) continue;
      // Several series only happen where a query forgot to aggregate; taking
      // the sum keeps that case honest rather than silently dropping pods.
      out.set(point.t, (out.get(point.t) ?? 0) + point.v);
    }
  }
  return out;
}

/**
 * Usage over a range, as the same `UsageSample[]` the live buffer produces.
 *
 * The three queries share a start, end and step, so their timestamps line up
 * and the union of them is the sample clock. A bucket only one of them
 * answered for keeps `null` in the others — a gap, which the chart draws as
 * a gap rather than as a zero.
 */
export async function usageHistory(input: {
  scope: UsageScope;
  range: UsageRange;
}): Promise<UsageWindow> {
  const spec = RANGE_SPECS[input.range];
  const end = Date.now();
  const start = end - spec.windowMs;

  const restarts = restartQuery(input.scope, spec);
  // A declared line that could not be read is a missing line, not a missing
  // chart: usage still draws. But the failure is remembered — a swallowed
  // read that left a sibling series standing used to make the whole record
  // look answered, which silently dropped both the flat fallback and the
  // sentence explaining it.
  let declaredFailed = false;
  const declared = (resource: "cpu" | "memory", what: "requests" | "limits") =>
    commands
      .prometheusQueryRange(
        declaredQuery(input.scope, resource, what),
        start,
        end,
        spec.stepSeconds
      )
      .catch(() => {
        declaredFailed = true;
        return [] as PromSeries[];
      });
  const [cpu, memory, started, cpuReq, cpuLim, memReq, memLim] =
    await Promise.all([
      commands.prometheusQueryRange(
        cpuQuery(input.scope, spec),
        start,
        end,
        spec.stepSeconds
      ),
      commands.prometheusQueryRange(
        memoryQuery(input.scope, spec),
        start,
        end,
        spec.stepSeconds
      ),
      restarts
        ? commands.prometheusQueryRange(restarts, start, end, spec.stepSeconds)
        : Promise.resolve([] as PromSeries[]),
      declared("cpu", "requests"),
      declared("cpu", "limits"),
      declared("memory", "requests"),
      declared("memory", "limits"),
    ]);

  const cpuAt = byTime(cpu);
  const memoryAt = byTime(memory);
  const startsAt = byTime(started);

  const clock = [
    ...new Set([...cpuAt.keys(), ...memoryAt.keys(), ...startsAt.keys()]),
  ].sort((a, b) => a - b);

  // `changes()` reports how many restarts happened *inside* each bucket; the
  // chart's marker fires on a cumulative counter going up, which is what the
  // live path feeds it. Running the total here means one restart rule for
  // both sources instead of a second code path in the chart.
  let total = 0;
  const samples: UsageSample[] = clock.map((t) => {
    total += startsAt.get(t) ?? 0;
    return {
      t,
      cpuMillicores: cpuAt.get(t) ?? null,
      memoryBytes: memoryAt.get(t) ?? null,
      restarts: total,
    };
  });

  const declaredSeries: DeclaredHistory = {
    cpuRequest: pointsOf(cpuReq),
    cpuLimit: pointsOf(cpuLim),
    memoryRequest: pointsOf(memReq),
    memoryLimit: pointsOf(memLim),
  };
  const anyDeclared = Object.values(declaredSeries).some(
    (points) => points.length > 0
  );

  // A series in hand is its own proof the record is kept; only an empty one
  // has to ask. `null` from the probe is "could not tell", and then the
  // record is not claimed either way.
  const keeps = anyDeclared ? true : await keepsDeclared();
  return {
    samples,
    resolution: spec.resolution,
    declared: keeps === true ? declaredSeries : null,
    declaredKnown: keeps !== null && !declaredFailed,
  };
}

/** Every node's usage in two range queries, plus when each last reported. */
export async function nodeUsage(input: {
  range: UsageRange;
}): Promise<NodeUsageWindow> {
  const spec = RANGE_SPECS[input.range];
  const end = Date.now();
  const start = end - spec.windowMs;
  const [cpu, memory, newest] = await Promise.all([
    commands.prometheusQueryRange(
      nodesQuery("cpu", spec),
      start,
      end,
      spec.stepSeconds
    ),
    commands.prometheusQueryRange(
      nodesQuery("memory", spec),
      start,
      end,
      spec.stepSeconds
    ),
    // Remembered rather than swallowed: an empty `newestAt` used to read as
    // "Prometheus has never had a series for this node", which is a claim
    // about the cluster made out of a failed request.
    commands.prometheusQuery(nodesNewestQuery()).catch(() => null),
  ]);

  const nodes: NodeUsageWindow["nodes"] = {};
  const lane = (name: string) =>
    (nodes[name] ??= { cpuMillicores: [], memoryBytes: [] });
  for (const series of cpu) {
    const name = nodeNameOf(series);
    if (name) lane(name).cpuMillicores = pointsOf([series]);
  }
  for (const series of memory) {
    const name = nodeNameOf(series);
    if (name) lane(name).memoryBytes = pointsOf([series]);
  }
  const newestAt: Record<string, number> = {};
  for (const series of newest ?? []) {
    const name = nodeNameOf(series);
    const seconds = series.points[0]?.v;
    if (name && typeof seconds === "number") newestAt[name] = seconds * 1000;
  }
  return {
    nodes,
    newestAt,
    newestKnown: newest !== null,
    resolution: spec.resolution,
  };
}

/** Bytes in and out, on the same clock as {@link usageHistory}. */
export async function networkTraffic(input: {
  scope: UsageScope;
  range: UsageRange;
}): Promise<TrafficWindow> {
  const spec = RANGE_SPECS[input.range];
  const receive = trafficQuery(input.scope, spec, "receive");
  const transmit = trafficQuery(input.scope, spec, "transmit");
  if (!receive || !transmit) {
    return { points: [], resolution: spec.resolution };
  }

  const end = Date.now();
  const start = end - spec.windowMs;
  const [rx, tx] = await Promise.all([
    commands.prometheusQueryRange(receive, start, end, spec.stepSeconds),
    commands.prometheusQueryRange(transmit, start, end, spec.stepSeconds),
  ]);

  const rxAt = byTime(rx);
  const txAt = byTime(tx);
  const clock = [...new Set([...rxAt.keys(), ...txAt.keys()])].sort(
    (a, b) => a - b
  );

  return {
    points: clock.map((t) => ({
      t,
      rx: rxAt.get(t) ?? null,
      tx: txAt.get(t) ?? null,
    })),
    resolution: spec.resolution,
  };
}

/**
 * How full each claim is — only the ones the kubelet actually reported.
 *
 * A claim that answers one query and not the other is dropped rather than
 * halved: `used` without `capacity` is a number with no denominator, and the
 * storage row's fallback sentence is a better answer than a bar drawn
 * against a total nobody measured.
 */
export async function volumeFullness(input: {
  namespace: string;
  claims: string[];
}): Promise<VolumeFullness[]> {
  if (input.claims.length === 0) return [];

  const [used, capacity] = await Promise.all([
    commands.prometheusQuery(volumeUsedQuery(input.namespace, input.claims)),
    commands.prometheusQuery(
      volumeCapacityQuery(input.namespace, input.claims)
    ),
  ]);

  const capacityOf = byClaim(capacity);
  const out: VolumeFullness[] = [];
  for (const [claim, usedBytes] of byClaim(used)) {
    const capacityBytes = capacityOf.get(claim);
    if (capacityBytes === undefined || capacityBytes <= 0) continue;
    out.push({ claim, usedBytes, capacityBytes });
  }
  return out;
}

function byClaim(series: PromSeries[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const one of series) {
    const claim = one.labels["persistentvolumeclaim"];
    const value = one.points[one.points.length - 1]?.v;
    if (claim && value !== null && value !== undefined) out.set(claim, value);
  }
  return out;
}
