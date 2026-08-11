/**
 * The window behind the usage chart.
 *
 * `metrics.k8s.io` stores nothing. It answers with the last ~30s of a
 * running kubelet and has no concept of a range query, so there is no
 * "yesterday" to ask for — the only history that can exist is the one this
 * app accumulates while a page is open. Everything here is that buffer and
 * the arithmetic that turns it into a series. The pixels are recharts'
 * business; what a bucket is worth, and where the top of the scale sits,
 * are decisions this app has to own.
 *
 * Two rules the rest of the app depends on:
 *
 *  - **Buckets take the max, never the mean.** A mean across a bucket hides
 *    the thirty seconds that got a container OOM-killed, which is the one
 *    reading anybody opens this chart for.
 *  - **A series is keyed by uid, not by name.** A replaced pod carries the
 *    old name and is a different process with a different heap; stitching
 *    the two together draws a continuous line across a discontinuity that
 *    is the entire thing worth seeing.
 */

/** One poll. `null` means metrics-server reported nothing for this object. */
export interface UsageSample {
  /** Wall clock of the poll that produced it, in epoch ms. */
  t: number;
  cpuMillicores: number | null;
  memoryBytes: number | null;
  /** Cumulative container restarts, when the caller has them. */
  restarts: number | null;
}

/** A bucketed point ready to be drawn. */
export interface UsagePoint {
  /** Wall clock of the sample the value came from, not the bucket midpoint —
   *  the tooltip should name the moment of the spike, not of the bucket. */
  t: number;
  /** `null` when no sample landed in this bucket: a gap, not a zero. */
  v: number | null;
  /** A restart was observed at or before this bucket and after the last one. */
  restart: boolean;
}

/**
 * 30 minutes at the 2s metrics interval. Past this the reader is better
 * served by a Prometheus than by a bigger array, and the cost of keeping
 * one is ~40 bytes a sample.
 */
export const MAX_SAMPLES = 900;

/** How many buckets a band is drawn with. At ~500px wide that is ~4px each. */
export const BUCKET_COUNT = 120;

/**
 * Appends a sample, dropping the oldest past the cap.
 *
 * Returns the same array when the timestamp is one already held: the poll
 * clock is shared by every component reading the query, so the same tick
 * arrives from several subscribers and must count once.
 */
export function appendSample(
  samples: readonly UsageSample[],
  sample: UsageSample,
  cap: number = MAX_SAMPLES
): readonly UsageSample[] {
  const last = samples[samples.length - 1];
  if (last && last.t >= sample.t) return samples;
  const next = samples.length >= cap ? samples.slice(1) : samples.slice();
  next.push(sample);
  return next;
}

type Channel = "cpuMillicores" | "memoryBytes";

/**
 * Collapses samples into fixed-width buckets, keeping the largest value in
 * each and the wall clock it was seen at.
 *
 * The span is the buffer's own first-to-last, so a band always fills its
 * width — the chart is "what has been watched", and padding it out to some
 * nominal window would draw empty space that reads as downtime.
 */
export function bucketize(
  samples: readonly UsageSample[],
  channel: Channel,
  buckets: number = BUCKET_COUNT
): UsagePoint[] {
  if (samples.length === 0) return [];
  const first = samples[0].t;
  const last = samples[samples.length - 1].t;
  const span = last - first;

  // Fewer samples than buckets is the common case in the first minutes:
  // one bucket each, so the line has the resolution it was polled at.
  const n = span <= 0 ? 1 : Math.min(buckets, samples.length);
  const out: UsagePoint[] = Array.from({ length: n }, () => ({
    t: 0,
    v: null,
    restart: false,
  }));

  let previousRestarts: number | null = null;
  for (const sample of samples) {
    const index =
      span <= 0
        ? 0
        : Math.min(n - 1, Math.floor(((sample.t - first) / span) * n));
    const slot = out[index];

    const value = sample[channel];
    if (value !== null && (slot.v === null || value > slot.v)) {
      slot.v = value;
      slot.t = sample.t;
    }
    if (slot.t === 0) slot.t = sample.t;

    if (
      previousRestarts !== null &&
      sample.restarts !== null &&
      sample.restarts > previousRestarts
    ) {
      slot.restart = true;
    }
    if (sample.restarts !== null) previousRestarts = sample.restarts;
  }
  return out;
}

/** Room above the peak, so a maximum is not a stroke sliced by the frame. */
const HEADROOM = 1.25;

/**
 * The top of the y axis.
 *
 * With a limit the limit **is** the scale, so the height of the line is
 * how close the object is to being throttled or killed and nothing else.
 * A pod at 1% of its memory limit draws flat along the floor, which is the
 * correct picture: it has enormous headroom, and the wobble in its last
 * four minutes is not worth a 42px band. Scaling such a series to its own
 * peak instead would blow a 0.4m idle sidecar up into a line near the top
 * of the chart — a glance would read that as busy, and it is not.
 *
 * Without a limit there is no ceiling to draw against, so the scale falls
 * back to what the object has actually used. That scale is self-referential
 * and the band says so in words underneath rather than leaving the reader
 * to assume a denominator that does not exist.
 *
 * A breach always stays on screen: clipping the one moment worth seeing
 * would defeat the chart.
 */
export function chartMax(
  points: readonly UsagePoint[],
  limit: number | null
): number {
  let peak = 0;
  for (const point of points)
    if (point.v !== null && point.v > peak) peak = point.v;
  if (limit !== null && limit > 0) return Math.max(limit, peak);
  return peak > 0 ? peak * HEADROOM : 1;
}

/**
 * Whether the dashed rule can be drawn. It is the scale's own top whenever
 * a limit exists, so this is simply "is there a limit" — kept as a named
 * check so the component never has to restate the rule.
 */
export function limitInView(limit: number | null, max: number): boolean {
  return limit !== null && limit > 0 && limit <= max;
}

/** Indices carrying a restart, for the vertical marks. */
export function restartIndices(points: readonly UsagePoint[]): number[] {
  const out: number[] = [];
  points.forEach((point, index) => {
    if (point.restart) out.push(index);
  });
  return out;
}

/** The newest value actually reported, ignoring trailing gaps. */
export function latestValue(points: readonly UsagePoint[]): number | null {
  for (let index = points.length - 1; index >= 0; index--) {
    if (points[index].v !== null) return points[index].v;
  }
  return null;
}

/**
 * How long the buffer has been watching, spelled the way the header says
 * it: "4m so far". Under a minute it counts seconds, because the first
 * minute is exactly when the reader is wondering whether it is working.
 *
 * Measured between the first and last samples rather than against the
 * wall clock — the span the chart actually draws, and a number that does
 * not drift upward while the metrics query is paused or failing.
 */
export function watchedFor(samples: readonly UsageSample[]): string {
  if (samples.length === 0) return "0s";
  const seconds = Math.max(
    0,
    Math.round((samples[samples.length - 1].t - samples[0].t) / 1000)
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 === 0 ? "" : `${minutes % 60}m`}`;
}

/** `14:22:30` — the wall clock a tooltip names, in the reader's own zone. */
export function clockOf(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * "38s ago" / "4m ago", to sit beside the wall clock.
 *
 * `now` is the newest sample's own timestamp, not the wall clock: it is
 * the last moment the cluster is known to have answered, and reading it
 * off the data keeps the component pure.
 */
export function agoOf(t: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
