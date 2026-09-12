import type { LogLevel } from "@/generated/types";

/**
 * Two log lines are "the same line" when they came from the same
 * statement in the same program. Nothing in the stream says so, so the
 * only proxy available is the shape a message keeps once the parts that
 * vary per occurrence are blanked out.
 *
 * Over-normalising is the expensive mistake here, not under-normalising.
 * Blank too much and `GET /checkout 200` merges with `GET /cart 500`,
 * and the collapsed row hides the one line the reader opened the pane
 * for. So these rules only touch runs that carry no meaning on their
 * own — timestamps, ids, durations, numbers — and never touch a word.
 * `deadbeef` stays `deadbeef`; `disk full` never merges with `disk warm`.
 */

/**
 * Order is load-bearing. A timestamp is digits and separators, a UUID is
 * hex groups, a duration is a number with a suffix — run the coarse rule
 * first and the fine ones never see their input.
 */
const RULES: Array<[RegExp, (match: string) => string]> = [
  // ISO-8601, with or without fraction and zone. Must precede everything.
  [
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    () => "<ts>",
  ],
  // Bare clock times: 12:04:31.220, 12:04:31.
  [/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, () => "<ts>"],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    () => "<uuid>",
  ],
  [/\b0x[0-9a-f]+\b/gi, () => "<hex>"],
  // A bare hex run only counts as an id if it mixes digits and a-f.
  // All-letters is a word (`deadbeef`, `cafe`), all-digits is a counter
  // and belongs to the number rule — treating `12345678` as hex would
  // split the flood the moment its counter crossed eight digits.
  [
    /\b[0-9a-f]{8,}\b/gi,
    (match) => (/\d/.test(match) && /[a-f]/i.test(match) ? "<hex>" : match),
  ],
  // Durations lose their unit as well as their number: Go and Rust both
  // print the same elapsed time as `900µs`, `1.5ms` or `2s` depending on
  // magnitude, so keeping the unit would split one statement three ways.
  [/\b\d+(?:\.\d+)?(?:ns|µs|us|ms|s|m|h)\b/g, () => "<dur>"],
  [/\d+(?:\.\d+)?/g, () => "<n>"],
  [/\s+/g, () => " "],
];

/**
 * Reduce a message to the shape it shares with its repeats. Pure, and
 * the same input always yields the same key — the grouping pass does
 * nothing but compare these strings.
 */
export function normalizeMessage(message: string): string {
  let out = message;
  for (const [pattern, replace] of RULES) out = out.replace(pattern, replace);
  return out.trim();
}

interface Groupable {
  message: string;
  level: LogLevel | null;
  pod: string;
  container: string;
  fields: Record<string, string> | null;
}

/**
 * The full identity a run is allowed to collapse across. The pod, the
 * container and the level are in the key rather than checked alongside it,
 * so a run can never straddle any of them. The pod matters on a workload
 * pane: five replicas writing the same sentence within one reorder window
 * would otherwise collapse into one row drawn in the first pod's lane —
 * one pod that cannot reach the database instead of five.
 *
 * A sidecar's line and the app's line
 * are different lines however alike they read, and a message that
 * changes level has changed what it is saying.
 *
 * The set of parsed field *keys* is in too. Values vary per occurrence
 * and that is the point, but a line that suddenly carries `error=` is a
 * different branch of the same statement and deserves its own row.
 */
export function groupKeyFor(line: Groupable): string {
  const fieldKeys = line.fields
    ? Object.keys(line.fields).sort().join(",")
    : "";
  return `${line.pod}\u0000${line.container}\u0000${line.level ?? ""}\u0000${fieldKeys}\u0000${normalizeMessage(line.message)}`;
}
