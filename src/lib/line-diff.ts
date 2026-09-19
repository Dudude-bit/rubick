/**
 * A line diff, the way the YAML viewer draws one.
 *
 * Myers' algorithm rather than the LCS table it replaces: the table was
 * O(m·n) in time and memory, which for two 3 000-line manifests is nine
 * million cells built on the main thread while the confirmation dialog is
 * opening. Myers is O((m+n)·d), where d is how much actually changed, and
 * an edit that touches three lines of a long file costs three passes.
 *
 * The output is the same shape the viewer has always drawn, so the worker
 * and the synchronous path answer identically and a test holds them to it.
 */

export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNumber: number;
}

/** Below this many lines in total the round trip to a worker costs more than the diff. */
export const SYNC_LINES = 400;

/**
 * The most the saved frontiers may take before the exact answer is given up.
 *
 * Myers is cheap when little changed, and this is the other end: it keeps one
 * `Int32Array` of width `2(n+m)+2` per step, so the cost is the edit distance
 * times the file size. Two 3 000-line manifests where every line moved is
 * ~6 000 steps of 48 KiB — about 290 MB, in a worker, for a diff nobody can
 * read line by line anyway. Past this the answer is the honest coarse one:
 * all of the old removed, all of the new added.
 */
const MAX_TRACE_BYTES = 32 * 1024 * 1024;

export function computeLineDiff(
  original: string,
  modified: string
): DiffLine[] {
  const a = original.split("\n");
  const b = modified.split("\n");
  const ops = myers(a, b);
  if (ops === null) return wholesale(a, b);
  const out: DiffLine[] = [];
  let line = 1;
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "=") {
      out.push({ type: "unchanged", content: a[i], lineNumber: line++ });
      i += 1;
      j += 1;
    } else if (op === "-") {
      out.push({ type: "removed", content: a[i], lineNumber: line++ });
      i += 1;
    } else {
      out.push({ type: "added", content: b[j], lineNumber: line++ });
      j += 1;
    }
  }
  return out;
}

/**
 * Every old line removed and every new one added, for a pair too far apart
 * to walk exactly. Coarse, and true: it rebuilds both sides like any other
 * answer here, which is what the diff tests check.
 */
function wholesale(a: readonly string[], b: readonly string[]): DiffLine[] {
  let line = 1;
  return [
    ...a.map((content): DiffLine => ({ type: "removed", content, lineNumber: line++ })),
    ...b.map((content): DiffLine => ({ type: "added", content, lineNumber: line++ })),
  ];
}

type Op = "=" | "-" | "+";

/**
 * The shortest edit script from `a` to `b`, as Myers describes it: walk the
 * edit graph one diagonal at a time, keep the furthest x reached on each,
 * and read the path back off the saved frontiers.
 */
function myers(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  // v[k + offset] is the furthest x on diagonal k; one copy per step d, so
  // the path can be read back once the end is reached.
  let v = new Int32Array(2 * max + 2);
  v[offset + 1] = 0;
  // trace[d] is the frontier after step d, which is what step d + 1 chose
  // its direction from and what the walk back reads to undo that choice.
  const trace: Int32Array[] = [];
  // How many steps fit in the budget above, for these two files.
  const steps = Math.max(1, Math.floor(MAX_TRACE_BYTES / ((2 * max + 2) * 4)));

  outer: for (let d = 0; d <= max; d += 1) {
    // Given up rather than grown without bound. `null` is not "no edits":
    // the caller turns it into a whole-file replace, which is true.
    if (d > steps) return null;
    const next = new Int32Array(v);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        break outer;
      }
    }
    trace.push(next);
    v = next;
  }

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const frontier = trace[d - 1];
    const k = x - y;
    let prevK: number;
    if (
      k === -d ||
      (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])
    ) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = frontier[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push("+");
    } else {
      ops.push("-");
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}
