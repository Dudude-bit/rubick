import type { LogLevel } from "@/generated/types";
import type { StreamedLogLine } from "./types";

/**
 * The buffer's shape over time, sliced.
 *
 * Everything here is deliberately outside React: the strip recomputes
 * four times a second on a buffer of up to forty thousand lines, and the
 * only way that stays free is if a batch touches the slices it landed in
 * rather than all of them. See `advanceDensity`.
 */

/**
 * Slice durations the strip is allowed to use, with what to call them.
 *
 * A ladder rather than a constant, because neither constant works. A
 * fixed slice count makes every slice a meaningless fraction — 1/84th of
 * eleven seconds is 131ms and 1/84th of four hours is 2m 51s, and the
 * axis under it can only be read by doing division. A fixed duration is
 * worse in the other direction: 1s slices are one bar under `flood-demo`
 * and four thousand bars on a pod that has been up since breakfast.
 *
 * So: the slice is a duration a person already thinks in, and the strip
 * picks the finest rung that still fits the span it has to cover. Every
 * rung is a whole number of the units it is named in, which is what lets
 * the slices be aligned to the clock instead of to the first line — a
 * 5-minute slice starts at :00 and :05, so the axis labels are times
 * that exist rather than "1m 43s after whatever we happened to keep".
 */
const STEPS: ReadonlyArray<readonly [ms: number, label: string]> = [
  [100, "100 ms"],
  [250, "250 ms"],
  [500, "500 ms"],
  [1_000, "1 s"],
  [2_000, "2 s"],
  [5_000, "5 s"],
  [10_000, "10 s"],
  [15_000, "15 s"],
  [30_000, "30 s"],
  [60_000, "1 min"],
  [120_000, "2 min"],
  [300_000, "5 min"],
  [600_000, "10 min"],
  [900_000, "15 min"],
  [1_800_000, "30 min"],
  [3_600_000, "1 h"],
  [7_200_000, "2 h"],
  [21_600_000, "6 h"],
  [43_200_000, "12 h"],
  [86_400_000, "1 day"],
];

export const FINEST_STEP_MS = STEPS[0][0];

/**
 * Fewer than this and it is not a map. One bar spanning the whole buffer
 * says nothing a line count does not already say, and two says nearly as
 * little; the strip refuses and prints the span instead.
 */
export const MIN_USEFUL_SLICES = 3;

/**
 * The finest rung whose slices still fit in `maxSlices` bars.
 *
 * `maxSlices` comes from the measured width, so the same pod gives a
 * coarser strip in a 360px peek panel than in a full window — the rule
 * is "a bar is a few pixels wide", not "there are 84 bars". Because the
 * rungs are at most 3x apart, the slice count never falls below a third
 * of the budget, so the strip is never a handful of fat bars either.
 */
export function chooseStep(spanMs: number, maxSlices: number): number {
  for (const [step] of STEPS) {
    if (spanMs / step <= maxSlices) return step;
  }
  return STEPS[STEPS.length - 1][0];
}

/** What to call a slice of this length, in units a person uses. */
export function stepLabel(step: number): string {
  return STEPS.find(([ms]) => ms === step)?.[1] ?? `${step} ms`;
}

export interface DensityBucket {
  /** Clock-aligned start of the slice. */
  start: number;
  total: number;
  warn: number;
  err: number;
}

export interface Density {
  step: number;
  /** Minutes-as-ms the slices were aligned against; see `alignTo`. */
  offset: number;
  /**
   * Dense and gapless. A pod that said nothing for four minutes gets
   * four minutes of empty slices, because the gap *is* the finding — a
   * strip that packed the bars together would draw silence as activity.
   */
  buckets: DensityBucket[];
  /** Tallest slice; the height every bar is drawn against. */
  peak: number;
  /** First and last line the strip was built from. */
  from: number;
  to: number;
  lines: number;
  warnings: number;
  errors: number;
  /** Slices holding at least one error — what "3 bursts" counts. */
  errorSlices: number;
}

export const EMPTY_DENSITY: Density = {
  step: FINEST_STEP_MS,
  offset: 0,
  buckets: [],
  peak: 0,
  from: 0,
  to: 0,
  lines: 0,
  warnings: 0,
  errors: 0,
  errorSlices: 0,
};

/** Only two levels get their own colour in a 30px bar; the rest are volume. */
export function severityOf(level: LogLevel | null): "err" | "warn" | null {
  if (level === "error" || level === "fatal") return "err";
  if (level === "warn") return "warn";
  return null;
}

/**
 * Slice boundaries on the wall clock rather than on the first line.
 *
 * Two reasons, and the second is the one that matters. A 1-minute slice
 * that starts at :00 can be labelled with a time that exists. And it does
 * not move when a line arrives or the head is dropped, which is the whole
 * reason the histogram can be updated instead of rebuilt: a slice's
 * identity is its start, not its index.
 *
 * The offset is the local UTC offset, taken once so that every slice is
 * the same length even across a DST boundary. Without it an hour slice
 * would start at :00 UTC, which is :30 on half the planet's clocks.
 */
export function alignTo(epoch: number, step: number, offset: number): number {
  return Math.floor((epoch - offset) / step) * step + offset;
}

function emptyBucket(start: number): DensityBucket {
  return { start, total: 0, warn: 0, err: 0 };
}

/**
 * The slice an instant belongs to, growing the array to reach it.
 *
 * Growth in both directions: the buffer is append-ordered per reorder
 * window but not across them, so a container running a window behind can
 * land a line one slice earlier than anything already counted.
 */
function bucketFor(density: Density, epoch: number): DensityBucket {
  const start = alignTo(epoch, density.step, density.offset);
  const buckets = density.buckets;
  if (buckets.length === 0) {
    const bucket = emptyBucket(start);
    buckets.push(bucket);
    return bucket;
  }

  const index = (start - buckets[0].start) / density.step;
  if (index < 0) {
    for (let i = 0; i < -index; i++) {
      buckets.unshift(emptyBucket(buckets[0].start - density.step));
    }
    return buckets[0];
  }
  while (buckets.length <= index) {
    buckets.push(emptyBucket(buckets[buckets.length - 1].start + density.step));
  }
  return buckets[index];
}

function countInto(density: Density, line: StreamedLogLine): void {
  const bucket = bucketFor(density, line.epoch);
  bucket.total++;
  const severity = severityOf(line.level);
  if (severity === "err") bucket.err++;
  else if (severity === "warn") bucket.warn++;
}

/**
 * Totals read back off the slices rather than carried along beside them.
 *
 * A hundred-odd slices is nothing to walk, and deriving means an
 * incremental update cannot drift from a rebuild — which it otherwise
 * would the first time the head was dropped and the totals were not told.
 */
function summarise(
  density: Density,
  logs: readonly StreamedLogLine[]
): Density {
  let peak = 0;
  let lines = 0;
  let errors = 0;
  let warnings = 0;
  let errorSlices = 0;
  for (const bucket of density.buckets) {
    if (bucket.total > peak) peak = bucket.total;
    lines += bucket.total;
    errors += bucket.err;
    warnings += bucket.warn;
    if (bucket.err > 0) errorSlices++;
  }
  density.peak = peak;
  density.lines = lines;
  density.errors = errors;
  density.warnings = warnings;
  density.errorSlices = errorSlices;
  density.from = logs.length > 0 ? logs[0].epoch : 0;
  density.to = logs.length > 0 ? logs[logs.length - 1].epoch : 0;
  return density;
}

/** Every line, from scratch. The fallback, not the usual path. */
export function buildDensity(
  logs: readonly StreamedLogLine[],
  step: number
): Density {
  if (logs.length === 0) return { ...EMPTY_DENSITY, step };
  // One offset for the whole strip, from the oldest line: a DST change
  // inside the buffer must not make one slice an hour longer than its
  // neighbours.
  const offset = new Date(logs[0].epoch).getTimezoneOffset() * 60_000;
  const density: Density = { ...EMPTY_DENSITY, step, offset, buckets: [] };
  for (const line of logs) countInto(density, line);
  return summarise(density, logs);
}

/**
 * The head slice, recounted from the buffer.
 *
 * Dropping whole slices that fell off the front is easy — their lines are
 * gone and so are they. The slice straddling the new head is the hard
 * one: some of its lines were evicted and the evicted ones are no longer
 * anywhere to be subtracted, so the only honest thing is to count what is
 * left. Bounded by one slice's worth of lines, and only when the head has
 * actually moved.
 */
function retrimHead(density: Density, logs: readonly StreamedLogLine[]): void {
  const buckets = density.buckets;
  if (buckets.length === 0 || logs.length === 0) return;

  const start = alignTo(logs[0].epoch, density.step, density.offset);
  const stale = Math.floor((start - buckets[0].start) / density.step);
  if (stale >= buckets.length) {
    buckets.length = 0;
    for (const line of logs) countInto(density, line);
    return;
  }
  if (stale > 0) buckets.splice(0, stale);

  const head = buckets[0];
  const end = head.start + density.step;
  head.total = 0;
  head.warn = 0;
  head.err = 0;
  for (let i = 0; i < logs.length && logs[i].epoch < end; i++) {
    if (logs[i].epoch < head.start) continue;
    head.total++;
    const severity = severityOf(logs[i].level);
    if (severity === "err") head.err++;
    else if (severity === "warn") head.warn++;
  }
}

/**
 * Where the line we last counted sits now.
 *
 * The hint is right whenever nothing was dropped, which is most of the
 * time. When the cap did evict, the shift equals what was dropped, so
 * walking back from the tail finds it in batch-sized time rather than
 * buffer-sized time. Ids are unique but not monotonic in array order —
 * the reorder window sorts by timestamp — so this is a search for an id
 * and not a comparison against one.
 */
function locate(
  logs: readonly StreamedLogLine[],
  id: number,
  hint: number
): number {
  if (hint >= 0 && hint < logs.length && logs[hint].id === id) return hint;
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].id === id) return i;
  }
  return -1;
}

/**
 * What the accumulator has to remember between batches. Held in a ref by
 * the strip; meaningless to anyone else.
 */
export interface DensityCursor {
  /** Identity of the filtered set. A different query is a different strip. */
  scope: string;
  /** Last line counted, and where it was when we counted it. */
  tailId: number;
  tailIndex: number;
  /** Oldest line counted. A change here means the cap evicted. */
  headId: number;
  density: Density;
}

export const INITIAL_CURSOR: DensityCursor = {
  scope: "",
  tailId: -1,
  tailIndex: -1,
  headId: -1,
  density: EMPTY_DENSITY,
};

/**
 * Move the histogram on to this buffer, counting as few lines as the
 * difference allows.
 *
 * The usual batch appends a few hundred lines to the tail and evicts as
 * many from the head, so the work is those lines plus one slice — not the
 * forty thousand standing between them. A full rebuild happens only when
 * the query changed, when the span outgrew its rung (which can happen at
 * most once per rung, twenty times over the life of a stream), or when
 * the buffer was replaced outright.
 *
 * Mutates the cursor and returns a fresh snapshot: the slices are copied
 * out so that whatever renders them sees a new object every time, and can
 * never be memoized onto a bucket that was mutated underneath it.
 */
export function advanceDensity(
  cursor: DensityCursor,
  logs: readonly StreamedLogLine[],
  maxSlices: number,
  scope: string
): Density {
  if (logs.length === 0) {
    cursor.scope = scope;
    cursor.tailId = -1;
    cursor.tailIndex = -1;
    cursor.headId = -1;
    cursor.density = EMPTY_DENSITY;
    return EMPTY_DENSITY;
  }

  const span = logs[logs.length - 1].epoch - logs[0].epoch;
  const step = chooseStep(Math.max(0, span), maxSlices);
  const previous = cursor.density;

  let density: Density;
  if (
    cursor.scope !== scope ||
    previous.step !== step ||
    previous.buckets.length === 0
  ) {
    density = buildDensity(logs, step);
  } else {
    const at = locate(logs, cursor.tailId, cursor.tailIndex);
    if (at < 0) {
      density = buildDensity(logs, step);
    } else {
      density = previous;
      for (let i = at + 1; i < logs.length; i++) countInto(density, logs[i]);
      if (cursor.headId !== logs[0].id) retrimHead(density, logs);
      summarise(density, logs);
    }
  }

  cursor.scope = scope;
  cursor.density = density;
  cursor.tailIndex = logs.length - 1;
  cursor.tailId = logs[cursor.tailIndex].id;
  cursor.headId = logs[0].id;

  return { ...density, buckets: density.buckets.map((b) => ({ ...b })) };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * An axis label at the precision its slice deserves, and no more.
 *
 * A 5-minute slice labelled to the second claims a resolution the bar
 * under it does not have; a 250ms slice labelled to the minute gives
 * three identical labels. The day is only spelled out when the span could
 * otherwise wrap around the clock and read as an hour ago.
 */
export function axisLabel(epoch: number, step: number, spanMs: number): string {
  const date = new Date(epoch);
  const clock =
    step < 60_000
      ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (spanMs <= 12 * 3_600_000) return clock;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
}

/** A slice's own label, to the second, for a tooltip or a screen reader. */
export function sliceClock(epoch: number): string {
  const date = new Date(epoch);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
