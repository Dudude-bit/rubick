/**
 * Finding a cluster by typing part of its name.
 *
 * Context names are long and structured — `gke_acme-prod_europe-west1_main`,
 * `arn:aws:eks:us-east-1:1234:cluster/prod` — and the part a reader types is
 * one word out of the middle. A plain edit distance is the wrong tool for
 * that shape: `prod` against that ARN is a distance of 35, which sorts the
 * obvious match below every seven-letter name that merely shares letters. So
 * the order is a ladder of *kinds* of match — exact, prefix, substring,
 * subsequence — and distance is only ever the tie-break inside one rung. A
 * name on no rung at all is not offered: picking the wrong cluster is the
 * expensive mistake here, so a short list beats a long one ordered by how
 * nearly each was meant.
 *
 * @module lib/cluster-search
 */

/** How a name matched, best first. The index is the rung number. */
export const RUNGS = ["exact", "prefix", "substring", "subsequence"] as const;

export type MatchRung = (typeof RUNGS)[number];

export interface ContextMatch {
  context: string;
  /**
   * The string `marks` index into — the context name, or the name this
   * person gave it. A cluster is offered under whichever of the two the
   * reader actually typed at.
   */
  matched: string;
  /** `matched` is an alias, not the context name. */
  viaAlias: boolean;
  rung: MatchRung;
  /**
   * Half-open `[start, end)` ranges of `matched` the needle landed on, so
   * the row can mark them and the ranking can be read off the screen
   * instead of taken on faith.
   */
  marks: Array<[number, number]>;
  /** Tie-break within a rung, never across rungs. */
  distance: number;
}

/** How a name matched, before it is known whose name it was. */
interface Rungs {
  rung: MatchRung;
  marks: Array<[number, number]>;
  distance: number;
}

/** The bang, split into the cluster being named and the query after it. */
export interface Bang {
  needle: string;
  rest: string;
}

/**
 * `!needle rest`. Null when the text is not a bang at all.
 *
 * The bang only counts at the very start: `!` inside a resource name is a
 * character, not a scope, and a box that changed meaning halfway through a
 * word would be unpredictable to type into.
 */
export function parseBang(text: string): Bang | null {
  if (!text.startsWith("!")) return null;
  const space = text.indexOf(" ");
  return space === -1
    ? { needle: text.slice(1), rest: "" }
    : { needle: text.slice(1, space), rest: text.slice(space + 1) };
}

/** Whether the needle is asking for every cluster rather than one. */
export function matchesAllClusters(needle: string): boolean {
  const value = needle.toLowerCase();
  return value === "" || value === "*" || "all".startsWith(value);
}

/**
 * Levenshtein distance, two rows deep. Only ever compared between names
 * already on the same rung, where it reduces to "how much of this name is not
 * what I typed".
 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/** Adjacent indices are one run: two marks touching are one highlight. */
function runs(indices: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const index of indices) {
    const last = out[out.length - 1];
    if (last && last[1] === index) last[1] = index + 1;
    else out.push([index, index + 1]);
  }
  return out;
}

/** Every needle character in order, not necessarily adjacent. */
function subsequenceOf(needle: string, haystack: string): number[] | null {
  const indices: number[] = [];
  let at = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found === -1) return null;
    indices.push(found);
    at = found + 1;
  }
  return indices;
}

/** Which rung one string sits on for `needle`, or null for none of them. */
function climb(query: string, text: string): Rungs | null {
  const value = text.toLowerCase();
  const gap = distance(query, value);

  if (value === query) {
    return { rung: "exact", marks: [[0, text.length]], distance: 0 };
  }
  if (value.startsWith(query)) {
    return { rung: "prefix", marks: [[0, query.length]], distance: gap };
  }
  const at = value.indexOf(query);
  if (at !== -1) {
    return {
      rung: "substring",
      marks: [[at, at + query.length]],
      distance: gap,
    };
  }
  const indices = subsequenceOf(query, value);
  if (indices) {
    return { rung: "subsequence", marks: runs(indices), distance: gap };
  }
  return null;
}

/** Best rung first, then shortest distance. Used to pick between two names. */
function better(a: Rungs, b: Rungs): Rungs {
  const rung = RUNGS.indexOf(a.rung) - RUNGS.indexOf(b.rung);
  if (rung !== 0) return rung < 0 ? a : b;
  return a.distance <= b.distance ? a : b;
}

/**
 * Which rung a cluster sits on for `needle`, or null for none of them.
 *
 * A cluster that has been renamed is climbed twice and the better of the two
 * rungs wins: an alias exists so nobody has to type the ARN again, and one
 * that could not be searched for would leave the mouse as the only way to
 * reach the cluster it names. The name that matched is carried back so the
 * row can show which of the two the reader hit.
 *
 * An empty needle is not "no rung": it is the reader who has typed `!` and
 * nothing else, and every cluster is still a candidate.
 */
export function matchContext(
  needle: string,
  context: string,
  alias?: string
): ContextMatch | null {
  const query = needle.toLowerCase();

  if (query === "") {
    return {
      context,
      matched: alias || context,
      viaAlias: !!alias,
      rung: "prefix",
      marks: [],
      distance: context.length,
    };
  }

  const onName = climb(query, context);
  const onAlias = alias ? climb(query, alias) : null;
  if (!onName && !onAlias) return null;

  const viaAlias =
    !onName || (!!onAlias && better(onAlias, onName) === onAlias);
  return {
    context,
    matched: viaAlias ? (alias as string) : context,
    viaAlias,
    ...((viaAlias ? onAlias : onName) as Rungs),
  };
}

/**
 * The clusters worth offering for `needle`, best first. An empty needle keeps
 * the kubeconfig's own order: with nothing typed there is nothing to rank by,
 * and the order the file lists them in is the one the reader has seen
 * everywhere else in the app.
 */
export function rankContexts(
  needle: string,
  contexts: readonly string[],
  /** What this person calls a cluster, where they call it something. */
  aliasOf?: (context: string) => string | undefined
): ContextMatch[] {
  const matches = contexts
    .map((context) => matchContext(needle, context, aliasOf?.(context)))
    .filter((match): match is ContextMatch => match !== null);

  if (needle === "") return matches;

  return matches.sort((a, b) => {
    const rung = RUNGS.indexOf(a.rung) - RUNGS.indexOf(b.rung);
    if (rung !== 0) return rung;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.context.localeCompare(b.context);
  });
}

/** The context text, split into the parts that matched and the parts that did not. */
export function splitMarks(
  context: string,
  marks: ReadonlyArray<readonly [number, number]>
): Array<{ text: string; matched: boolean }> {
  const parts: Array<{ text: string; matched: boolean }> = [];
  let at = 0;
  for (const [start, end] of marks) {
    if (start > at)
      parts.push({ text: context.slice(at, start), matched: false });
    parts.push({ text: context.slice(start, end), matched: true });
    at = end;
  }
  if (at < context.length) {
    parts.push({ text: context.slice(at), matched: false });
  }
  return parts;
}
