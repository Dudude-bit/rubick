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
  TrafficWindow,
  UsageRange,
  UsageScope,
  UsageWindow,
  VolumeFullness,
} from "../registry";
import {
  RANGE_SPECS,
  cpuQuery,
  memoryQuery,
  restartQuery,
  trafficQuery,
  volumeCapacityQuery,
  volumeUsedQuery,
} from "./queries";

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
  const [cpu, memory, started] = await Promise.all([
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

  return { samples, resolution: spec.resolution };
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
