import type { LogFormat, LogLevel, LogLine } from "@/generated/types";

export type ViewMode = "compact" | "table" | "raw";

/**
 * A line as the viewer holds it, with the three things the backend
 * cannot supply.
 *
 * `id` because `LogLine` has no identity — two events can carry
 * identical timestamp and message bytes, and React needs a stable key
 * so a filter shrinking the visible array does not remount unrelated
 * rows. It is assigned at receive time and is therefore also the
 * arrival order, which is what breaks ties when several containers
 * report the same instant.
 *
 * `epoch` and `groupKey` are precomputed for cost, not for taste: the
 * merge sorts on the first and the collapse compares the second, both
 * over the whole retained buffer several times a second. Parsing a
 * timestamp or running six regexes inside those loops is the difference
 * between a viewer and a stall.
 */
export type StreamedLogLine = LogLine & {
  id: number;
  /** ms since epoch; carried forward from the last line of the same stream when the line has no timestamp. */
  epoch: number;
  /** See `groupKeyFor` — container, level, field keys and the normalised message. */
  groupKey: string;
};

/**
 * One clause of the query, and the whole of what a chip stands for.
 *
 * A structured term rather than a substring because the reader has to be
 * able to see what they asked for and take it back: `level≥warn` is a
 * thing you can read off the toolbar and remove, where `warn` typed into
 * a search box is indistinguishable from a line that happens to contain
 * the word.
 */
export type QueryTerm =
  | { kind: "text"; value: string }
  | { kind: "level"; op: "=" | "≥"; value: LogLevel }
  | { kind: "field"; key: string; op: "=" | "≠"; value: string };

export const HIDDEN_FIELD_KEYS = new Set([
  "message",
  "msg",
  "log",
  "event",
  "level",
  "lvl",
  "severity",
]);

/** The level spelled out. An abbreviation nobody has to decode. */
export const LEVEL_WORDS: Record<LogLevel, string> = {
  fatal: "fatal",
  error: "error",
  warn: "warn",
  info: "info",
  debug: "debug",
  unknown: "unlabelled",
};

/**
 * Severity as an order, so `level≥warn` means something. `unknown` sits
 * at the bottom on purpose: a line the parser could not read a level out
 * of is not evidence of a problem, and a threshold query asking for
 * trouble should not return every unparsed line in the buffer.
 */
const LEVEL_RANK: Record<LogLevel, number> = {
  fatal: 5,
  error: 4,
  warn: 3,
  info: 2,
  debug: 1,
  unknown: 0,
};

/**
 * Log levels collapse onto the same roles the rest of the app uses, so a
 * warning in a log stream is the same yellow as a warning in a table.
 * `debug` no longer spends a hue on "less important than normal", and
 * `fatal` no longer needs a darker red than `error` to say the same thing.
 */
type LevelRole = "err" | "warn" | "info" | "mut";

const LEVEL_ROLE: Record<LogLevel, LevelRole> = {
  fatal: "err",
  error: "err",
  warn: "warn",
  info: "info",
  debug: "mut",
  unknown: "mut",
};

const byRole = (classes: Record<LevelRole, string>): Record<LogLevel, string> =>
  Object.fromEntries(
    Object.entries(LEVEL_ROLE).map(([level, role]) => [level, classes[role]])
  ) as Record<LogLevel, string>;

/**
 * The level colours the message itself rather than spending a column on a
 * three-letter word. `info` is deliberately the plain foreground: a stream
 * where every second line is INF gains nothing from tinting the majority,
 * and leaving it neutral is what makes the two lines that are not stand out.
 * The word is never lost — it is one click away in the row's detail, and it
 * is what `level≥warn` filters on.
 */
export const LEVEL_MESSAGE_COLORS = byRole({
  err: "text-err",
  warn: "text-warn",
  info: "text-fg",
  mut: "text-fg-mut",
});

/** The same four roles where the level is written out as a word. */
export const LEVEL_COLORS = byRole({
  err: "text-err",
  warn: "text-warn",
  info: "text-info",
  mut: "text-fg-fnt",
});

export const FORMAT_DESCRIPTIONS: Record<LogFormat, string> = {
  json: "Structured JSON log format with parsed fields",
  logfmt: 'Key=value pairs format (e.g., level=info msg="hello")',
  klog: "Kubernetes log format with severity prefix (I/W/E/F)",
  logback: "Java Logback format with timestamp and level",
  plain: "Plain text without structured formatting",
};

/**
 * Wall clock, 24-hour, fixed width. `toLocaleTimeString` was the reason the
 * time column read "AM": on an en-US locale it appends a meridiem the column
 * has no room for, and the part that gets clipped is the part that matters.
 */
export function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "--:--:--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/** The same clock with milliseconds, for the detail where there is room. */
export function formatTimestampPrecise(timestamp: string | null): string {
  if (!timestamp) return "no timestamp";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${formatTimestamp(timestamp)}.${ms}`;
}

/**
 * A run's duration, at the precision the number deserves. A burst that
 * landed inside one clock tick is "instant" rather than "0ms", which
 * reads like a measurement that failed.
 */
export function formatSpan(ms: number): string {
  if (ms <= 0) return "instant";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Long counts get a thin space between groups, as in the mock. A narrow
 * no-break space rather than a comma: these numbers sit inside prose like
 * "× 2 481 over 1m 12s", where a comma reads as punctuation of the sentence.
 */
export function formatCount(value: number): string {
  // Grouped by hand rather than by locale: `toLocaleString` picks its
  // separator from whatever ICU the host was built with, and this number has
  // to line up with the mono column beside it either way.
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

const LEVEL_NAMES = new Set(Object.keys(LEVEL_RANK));

const isLevel = (value: string): value is LogLevel =>
  LEVEL_NAMES.has(value.toLowerCase());

/**
 * Turn what someone typed into a term. `level>=warn` (or `≥`, or `>`) is a
 * threshold, `key=value` and `key!=value` are field tests, and anything
 * else is what it looks like: text to find.
 */
export function parseQueryTerm(input: string): QueryTerm | null {
  const raw = input.trim();
  if (raw === "") return null;

  const match = /^([A-Za-z_][\w.-]*)\s*(>=|≥|>|!=|≠|=)\s*(.+)$/.exec(raw);
  if (!match) return { kind: "text", value: raw };

  const [, key, op, rest] = match;
  const value = rest.trim().replace(/^["']|["']$/g, "");
  if (value === "") return { kind: "text", value: raw };

  if (key.toLowerCase() === "level" && isLevel(value)) {
    const level = value.toLowerCase() as LogLevel;
    return op === "=" || op === "!=" || op === "≠"
      ? { kind: "level", op: "=", value: level }
      : { kind: "level", op: "≥", value: level };
  }
  return {
    kind: "field",
    key,
    op: op === "!=" || op === "≠" ? "≠" : "=",
    value,
  };
}

/** What the chip reads. Also its identity — two equal labels are one term. */
export function termLabel(term: QueryTerm): string {
  if (term.kind === "text") return term.value;
  if (term.kind === "level") return `level${term.op}${term.value}`;
  return `${term.key}${term.op}${term.value}`;
}

function matchesTerm(log: StreamedLogLine, term: QueryTerm): boolean {
  if (term.kind === "text") {
    const needle = term.value.toLowerCase();
    return (
      log.message.toLowerCase().includes(needle) ||
      log.raw.toLowerCase().includes(needle)
    );
  }
  if (term.kind === "level") {
    const level = log.level ?? "unknown";
    return term.op === "="
      ? level === term.value
      : LEVEL_RANK[level] >= LEVEL_RANK[term.value];
  }
  // `container` is not a parsed field but it is the one every reader asks
  // about by name, and the legend and the row detail both offer it as one.
  const actual =
    term.key === "container" ? log.container : log.fields?.[term.key];
  return term.op === "="
    ? actual === term.value
    : actual !== undefined && actual !== term.value;
}

/** Every term has to hold: chips narrow, they do not widen. */
export function matchesQuery(
  log: StreamedLogLine,
  terms: readonly QueryTerm[]
): boolean {
  for (const term of terms) if (!matchesTerm(log, term)) return false;
  return true;
}

/**
 * The one way a log line becomes text. Download and copy have to agree —
 * a reader who copies a selection and a reader who downloads the file are
 * looking for the same bytes.
 */
export function logsToText(logs: LogLine[]): string {
  return logs
    .map((log) => log.raw || `${log.timestamp || ""} ${log.message}`)
    .join("\n");
}

export { LogFormat, LogLevel, LogLine };
