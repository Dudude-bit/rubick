import type { StreamedLogLine } from "./types";

/**
 * A run of consecutive lines that say the same thing.
 *
 * A run holds a range into the source array rather than a copy of the
 * lines: a buffer of 40 000 lines that repeats nothing would otherwise
 * allocate 40 000 single-element arrays every time a batch lands. The
 * head line is carried because every renderer needs it and indexing for
 * it is noise.
 */
export interface LogRun {
  /** The head line's id — unique, monotonic, and stable as a React key. */
  id: number;
  /** Index of the head line in the array the run was built from. */
  start: number;
  /** Always >= 1. A run of 1 is an ordinary line. */
  count: number;
  head: StreamedLogLine;
  tail: StreamedLogLine;
}

/**
 * Collapse consecutive repeats into runs.
 *
 * Consecutive is the whole contract: a run is a claim that the program
 * said one thing N times in a row, and reordering the buffer to gather
 * distant repeats would turn a count into a statistic and lose the
 * ordering that made the log worth reading. Container and level are
 * folded into `groupKey`, so a run can never straddle either.
 *
 * With `collapse` false every line gets its own run, so callers have
 * one row type either way.
 */
export function groupConsecutive(
  logs: readonly StreamedLogLine[],
  collapse = true
): LogRun[] {
  const runs: LogRun[] = [];
  if (!collapse) {
    for (let i = 0; i < logs.length; i++) {
      const line = logs[i];
      runs.push({ id: line.id, start: i, count: 1, head: line, tail: line });
    }
    return runs;
  }

  let current: LogRun | null = null;
  for (let i = 0; i < logs.length; i++) {
    const line = logs[i];
    if (current !== null && current.head.groupKey === line.groupKey) {
      current.count++;
      current.tail = line;
      continue;
    }
    current = { id: line.id, start: i, count: 1, head: line, tail: line };
    runs.push(current);
  }
  return runs;
}

/**
 * Milliseconds between the first and last line of a run. `0` for a run
 * of one, and for a burst that landed inside a single clock tick — the
 * flood pod emits three lines per microsecond, and rounding that up to
 * "1ms" would be an invention.
 */
export function runSpanMs(run: LogRun): number {
  return Math.max(0, run.tail.epoch - run.head.epoch);
}

/** The lines a run stands for, in order. */
export function expandRun(
  logs: readonly StreamedLogLine[],
  run: LogRun
): StreamedLogLine[] {
  return logs.slice(run.start, run.start + run.count) as StreamedLogLine[];
}

/**
 * Replace each expanded run with one single-line run per line it holds,
 * so an expanded group and an ordinary line are the same row type to
 * whatever draws them. Returns the input untouched when nothing is
 * expanded, which is the usual case and the one worth not copying.
 */
export function expandRuns(
  logs: readonly StreamedLogLine[],
  runs: LogRun[],
  expanded: ReadonlySet<number>
): LogRun[] {
  if (expanded.size === 0) return runs;
  const out: LogRun[] = [];
  for (const run of runs) {
    if (run.count === 1 || !expanded.has(run.id)) {
      out.push(run);
      continue;
    }
    for (let i = run.start; i < run.start + run.count; i++) {
      const line = logs[i];
      out.push({ id: line.id, start: i, count: 1, head: line, tail: line });
    }
  }
  return out;
}

/** How many lines the runs stand for, for a status bar that has to say so. */
export function countCollapsed(runs: readonly LogRun[]): number {
  let hidden = 0;
  for (const run of runs) hidden += run.count - 1;
  return hidden;
}
