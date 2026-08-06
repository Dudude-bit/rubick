import { HIDDEN_FIELD_KEYS, type StreamedLogLine } from "../types";

/**
 * How long an arriving line is held back before it is committed.
 *
 * Streaming five containers means five independent HTTP bodies, five
 * kubelet read loops and five 50ms backend flush timers, so the lines
 * do not arrive in timestamp order and nothing downstream can fix that
 * after the fact — sorting the whole retained buffer on every batch is
 * an O(n log n) pass over 40 000 entries twenty times a second.
 *
 * So: hold, sort, commit. Everything that arrives inside one window is
 * emitted in timestamp order; the committed buffer is append-only and
 * is never reordered afterwards.
 *
 * 250ms is chosen against the backend's own 50ms flush: it is five
 * flushes wide, so a container that is a flush or two behind still
 * lands in the same window as its peers, and it costs the live tail a
 * quarter-second of latency that a reader watching a log scroll cannot
 * perceive. It also cuts the re-render rate from ~20/s per stream to
 * 4/s total, which is why the flood is cheaper to watch than it was
 * with one stream.
 */
export const REORDER_WINDOW_MS = 250;

/**
 * Release early rather than let the hold grow without bound. A backfill
 * of several thousand lands as one burst, and holding all of it to sort
 * it is the right thing; holding a pod that emits 20 000 lines a second
 * is not.
 */
export const MAX_PENDING_LINES = 5000;

/**
 * Distinct values one key may carry before the index stops listing them.
 *
 * `request_id` has one value per line: recording them costs a map entry
 * per retained line and yields a list of ten thousand buttons nobody can
 * read. Past this point the index keeps only how many lines carry the
 * key, and the popover says so instead of pretending to offer a choice.
 */
export const MAX_TRACKED_VALUES = 50;

/**
 * What the retained buffer can be filtered by, counted as it fills.
 *
 * It lives here rather than in a `useMemo` over `logs` because a recount
 * is a pass over up to 40 000 lines and the buffer changes four times a
 * second; the append already walks every arriving line and the eviction
 * already knows exactly which lines left, so both ends of the count are
 * free. The maps are mutated in place — see `appendCapped` for why that
 * is still safe for React.
 */
export interface FieldIndex {
  /** key -> lines carrying it. Includes `container` and `level`, always. */
  keys: Map<string, number>;
  /**
   * key -> value -> lines. A key in `keys` but not here blew
   * `MAX_TRACKED_VALUES`; it is not restored when eviction thins it out
   * again, because the values that were never recorded cannot be
   * recovered without the recount this index exists to avoid.
   */
  values: Map<string, Map<string, number>>;
}

export interface LogBuffer {
  lines: StreamedLogLine[];
  /**
   * Lines evicted from the head since the stream started. Non-zero
   * means the viewer is no longer showing everything it received, and
   * that used to be silent.
   */
  dropped: number;
  fields: FieldIndex;
}

/**
 * A function rather than a shared constant: the index inside is mutable,
 * and one exported instance would carry the last pod's keys into the next.
 */
export const emptyBuffer = (): LogBuffer => ({
  lines: [],
  dropped: 0,
  fields: { keys: new Map(), values: new Map() },
});

/**
 * Everything a line can be filtered by. `container` and `level` are not
 * parsed fields, but they are the two filters a reader reaches for first
 * and every line has them, so the index carries them beside the rest.
 * The keys the parser writes a message under are skipped: filtering on
 * `msg=` the whole message is not a question anyone asks.
 */
function eachField(
  line: StreamedLogLine,
  visit: (key: string, value: string) => void
): void {
  visit("container", line.container);
  visit("level", line.level ?? "unknown");
  if (!line.fields) return;
  for (const key of Object.keys(line.fields)) {
    if (!HIDDEN_FIELD_KEYS.has(key)) visit(key, line.fields[key]);
  }
}

function indexLine(index: FieldIndex, line: StreamedLogLine): void {
  eachField(line, (key, value) => {
    const seen = index.keys.get(key) ?? 0;
    index.keys.set(key, seen + 1);
    if (seen === 0) {
      index.values.set(key, new Map([[value, 1]]));
      return;
    }
    const values = index.values.get(key);
    if (values === undefined) return;
    const count = values.get(value);
    if (count !== undefined) values.set(value, count + 1);
    else if (values.size < MAX_TRACKED_VALUES) values.set(value, 1);
    else index.values.delete(key);
  });
}

function unindexLine(index: FieldIndex, line: StreamedLogLine): void {
  eachField(line, (key, value) => {
    const seen = index.keys.get(key);
    if (seen === undefined) return;
    if (seen <= 1) {
      index.keys.delete(key);
      index.values.delete(key);
      return;
    }
    index.keys.set(key, seen - 1);
    const values = index.values.get(key);
    const count = values?.get(value);
    if (values === undefined || count === undefined) return;
    if (count <= 1) values.delete(value);
    else values.set(value, count - 1);
  });
}

/** One key of the index, ordered and ready to be offered. */
export interface FieldSuggestion {
  key: string;
  /** Lines in the retained buffer carrying it. */
  lines: number;
  /** By descending count. Empty when `wide`. */
  values: Array<{ value: string; lines: number }>;
  /** Too many distinct values to have been recorded. */
  wide: boolean;
}

/** The two that are not parsed fields, and are what people filter by first. */
const PINNED_KEYS = ["level", "container"];

/**
 * The index as a list: the two always-there keys, then whatever parsed,
 * loudest first. Derived on demand rather than maintained, because it is
 * only ever read while the suggestion popover is open — a sort over a few
 * dozen keys against a count that is already there.
 */
export function fieldSuggestions(index: FieldIndex): FieldSuggestion[] {
  const parsed = [...index.keys.keys()]
    .filter((key) => !PINNED_KEYS.includes(key))
    .sort(
      (a, b) => index.keys.get(b)! - index.keys.get(a)! || a.localeCompare(b)
    );

  return [...PINNED_KEYS.filter((key) => index.keys.has(key)), ...parsed].map(
    (key) => {
      const values = index.values.get(key);
      return {
        key,
        lines: index.keys.get(key)!,
        wide: values === undefined,
        values: values
          ? [...values]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([value, lines]) => ({ value, lines }))
          : [],
      };
    }
  );
}

/**
 * Order one reorder window by timestamp, arrival order breaking ties.
 *
 * `id` is assigned at receive time, so the tiebreak is a total order
 * and the result does not depend on the sort being stable. The
 * already-ordered check is not a micro-optimisation: with a single
 * container — still the common case — every window is already ordered
 * and the sort would be pure waste.
 */
export function orderByTimestamp(
  pending: StreamedLogLine[]
): StreamedLogLine[] {
  for (let i = 1; i < pending.length; i++) {
    if (pending[i].epoch < pending[i - 1].epoch) {
      return pending.slice().sort((a, b) => a.epoch - b.epoch || a.id - b.id);
    }
  }
  return pending;
}

/**
 * Append a window to the retained buffer, honouring one cap.
 *
 * `[...prev, ...batch].slice(-limit)` built a full-length array only to
 * throw the head of it away — two allocations and two full copies per
 * batch. Trim once, then push in place. The result is still a new
 * array: React re-renders on identity, and a buffer mutated in place
 * would go unnoticed.
 *
 * The field index rides along: every line pushed is counted and every
 * line evicted is uncounted, so the counts describe exactly the lines
 * that are retained without anyone walking the buffer to find out. Its
 * maps are mutated in place — nothing outside holds them across a
 * render — and handed back inside a fresh wrapper, which is the identity
 * the suggestion list memoizes on.
 */
export function appendCapped(
  prev: LogBuffer,
  batch: readonly StreamedLogLine[],
  limit: number
): LogBuffer {
  if (batch.length === 0) return prev;

  const index = prev.fields;
  const fields: FieldIndex = { keys: index.keys, values: index.values };

  if (limit <= 0) {
    for (const line of prev.lines) unindexLine(index, line);
    return {
      lines: [],
      dropped: prev.dropped + prev.lines.length + batch.length,
      fields,
    };
  }

  const overflow = prev.lines.length + batch.length - limit;
  const dropped = overflow > 0 ? prev.dropped + overflow : prev.dropped;

  if (batch.length >= limit) {
    for (const line of prev.lines) unindexLine(index, line);
    const lines = batch.slice(batch.length - limit);
    for (const line of lines) indexLine(index, line);
    return { lines, dropped, fields };
  }

  for (let i = 0; i < overflow; i++) unindexLine(index, prev.lines[i]);
  const lines = overflow > 0 ? prev.lines.slice(overflow) : prev.lines.slice();
  for (const line of batch) {
    lines.push(line);
    indexLine(index, line);
  }
  return { lines, dropped, fields };
}

/**
 * The number the backfill asks each container for.
 *
 * The cap counts lines in the viewer, not lines per container, so
 * asking every container for the whole cap would fetch N times what can
 * be kept and throw the difference away before the first frame — and
 * report a head already being dropped on a pane the reader has only
 * just opened.
 */
export function backfillPerContainer(
  limit: number,
  containers: number
): number {
  return Math.max(1, Math.ceil(limit / Math.max(1, containers)));
}
