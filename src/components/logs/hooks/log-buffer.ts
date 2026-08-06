import type { StreamedLogLine } from "../types";

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

export interface LogBuffer {
  lines: StreamedLogLine[];
  /**
   * Lines evicted from the head since the stream started. Non-zero
   * means the viewer is no longer showing everything it received, and
   * that used to be silent.
   */
  dropped: number;
}

export const EMPTY_BUFFER: LogBuffer = { lines: [], dropped: 0 };

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
 */
export function appendCapped(
  prev: LogBuffer,
  batch: readonly StreamedLogLine[],
  limit: number
): LogBuffer {
  if (batch.length === 0) return prev;
  if (limit <= 0) {
    return {
      lines: [],
      dropped: prev.dropped + prev.lines.length + batch.length,
    };
  }

  const overflow = prev.lines.length + batch.length - limit;
  const dropped = overflow > 0 ? prev.dropped + overflow : prev.dropped;

  if (batch.length >= limit) {
    return { lines: batch.slice(batch.length - limit), dropped };
  }

  const lines = overflow > 0 ? prev.lines.slice(overflow) : prev.lines.slice();
  for (const line of batch) lines.push(line);
  return { lines, dropped };
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
