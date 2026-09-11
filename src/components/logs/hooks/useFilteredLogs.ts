import { useEffect, useState } from "react";

import { matchesQuery, termLabel } from "../types";
import type { QueryTerm, StreamedLogLine } from "../types";

/**
 * Lines a pass looks at before yielding to the event loop: about two
 * milliseconds against a text term, under the frame budget in
 * `docs/perf.md`, and the whole of an ordinary buffer in one go so a small
 * pane answers a keystroke in the same render as before.
 */
export const SLICE_LINES = 4000;

export interface FilteredLogs {
  /** Lines the query and the legend allow, in buffer order. Partial while `settling`. */
  scoped: StreamedLogLine[];
  /**
   * A changed query is still being walked over the buffer. `scoped` is
   * what the walk has reached and not a verdict: an empty `scoped` here
   * means "not looked yet", never "nothing matches".
   */
  settling: boolean;
}

interface Pass {
  key: string;
  keep: (line: StreamedLogLine) => boolean;
  /** The buffer the pass was last reconciled with. */
  source: StreamedLogLine[];
  /** Index into `source` of the next line the pass has not looked at. */
  cursor: number;
  result: StreamedLogLine[];
}

function scanned(pass: Pass, budget: number): Pass {
  const end = Math.min(pass.source.length, pass.cursor + budget);
  if (pass.cursor >= end) return pass;
  const found: StreamedLogLine[] = [];
  for (let i = pass.cursor; i < end; i++) {
    const line = pass.source[i];
    if (pass.keep(line)) found.push(line);
  }
  return {
    ...pass,
    cursor: end,
    result: found.length > 0 ? [...pass.result, ...found] : pass.result,
  };
}

/**
 * The same pass, reconciled with the next buffer.
 *
 * The buffer is append-only and evicts in order (`appendCapped`), so the
 * new array is the old one minus some lines, plus a tail. Both the old
 * source and the result keep the old order, which is what lets one walk in
 * lockstep tell the evicted lines from the kept ones without a set, and
 * carry the cursor across: the survivors ahead of it are where it lands.
 * A buffer that is not the old one extended finds no survivors and is
 * walked from the start.
 */
function advanced(pass: Pass, logs: StreamedLogLine[]): Pass {
  const { source, result } = pass;
  let j = 0;
  let r = 0;
  let cursor = -1;
  let evicted = false;
  const kept: StreamedLogLine[] = [];
  for (let i = 0; i < source.length; i++) {
    if (i === pass.cursor) cursor = j;
    const line = source[i];
    const present = j < logs.length && logs[j] === line;
    if (present) j++;
    if (r < result.length && result[r] === line) {
      r++;
      if (present) kept.push(line);
      else evicted = true;
    }
  }
  return {
    ...pass,
    source: logs,
    cursor: cursor < 0 ? j : cursor,
    result: evicted ? kept : result,
  };
}

function started(
  key: string,
  logs: StreamedLogLine[],
  hidden: ReadonlySet<string>,
  terms: readonly QueryTerm[]
): Pass {
  const keep = (line: StreamedLogLine) =>
    !hidden.has(line.container) && matchesQuery(line, terms);
  return scanned(
    { key, keep, source: logs, cursor: 0, result: [] },
    SLICE_LINES
  );
}

/**
 * The buffer as the query and the legend leave it, kept up to date with
 * the stream at the cost of the change and not of the collection.
 *
 * A batch used to mean the whole buffer through `matchesQuery` again, and a
 * keystroke in the query box the same: forty thousand lines through two
 * `toLowerCase()`s four times a second, on the main thread, was the stutter.
 * Now a batch costs its own lines, and a new query walks the buffer in
 * slices of `SLICE_LINES`, handing the results over as it goes and yielding
 * to the input between them. The caller reads `settling` while that walk is
 * on, so an empty result on the way is never drawn as "nothing matches".
 *
 * The pass is state adjusted during render, not a ref: the next buffer is
 * reconciled in the render that receives it, and a batch on a settled pass
 * is looked at there too, so the view never trails the buffer by a tick.
 */
export function useFilteredLogs(
  logs: StreamedLogLine[],
  hidden: ReadonlySet<string>,
  terms: readonly QueryTerm[]
): FilteredLogs {
  const key = `${[...hidden].sort().join(",")}|${terms.map(termLabel).join(",")}`;
  const [pass, setPass] = useState<Pass>(() =>
    started(key, logs, hidden, terms)
  );

  let current = pass;
  if (pass.key !== key) {
    current = started(key, logs, hidden, terms);
    setPass(current);
  } else if (pass.source !== logs) {
    current = scanned(advanced(pass, logs), SLICE_LINES);
    setPass(current);
  }
  const settling = current.cursor < current.source.length;

  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => {
      setPass((latest) => scanned(latest, SLICE_LINES));
    }, 0);
    return () => clearTimeout(timer);
  }, [settling, current]);

  return { scoped: current.result, settling };
}
