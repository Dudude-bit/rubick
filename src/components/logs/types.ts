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

export interface LogFilter {
  search: string;
  levels: LogLevel[];
  fields: Record<string, string>;
}

export interface ActiveFilter {
  type: "level" | "field" | "search";
  key?: string;
  value: string;
  label: string;
}

export const HIDDEN_FIELD_KEYS = new Set([
  "message",
  "msg",
  "log",
  "event",
  "level",
  "lvl",
  "severity",
]);

export const LEVEL_LABELS: Record<LogLevel, string> = {
  fatal: "FTL",
  error: "ERR",
  warn: "WRN",
  info: "INF",
  debug: "DBG",
  unknown: "---",
};

/**
 * Log levels collapse onto the same roles the rest of the app uses, so a
 * warning in a log stream is the same yellow as a warning in a table. Two
 * per-level colour tables became one role map plus one class table per
 * surface; `debug` no longer spends a hue on "less important than normal",
 * and `fatal` no longer needs a darker red than `error` to say the same
 * thing. LEVEL_LABELS is always rendered alongside, so the level is never
 * carried by colour alone.
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

export const LEVEL_COLORS = byRole({
  err: "text-err",
  warn: "text-warn",
  info: "text-info",
  mut: "text-fg-fnt",
});

export const LEVEL_BORDER_COLORS = byRole({
  err: "border-err",
  warn: "border-warn",
  info: "border-info",
  mut: "border-transparent",
});

export const FORMAT_DESCRIPTIONS: Record<LogFormat, string> = {
  json: "Structured JSON log format with parsed fields",
  logfmt: 'Key=value pairs format (e.g., level=info msg="hello")',
  klog: "Kubernetes log format with severity prefix (I/W/E/F)",
  logback: "Java Logback format with timestamp and level",
  plain: "Plain text without structured formatting",
};

export function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "--:--:--";
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  } catch {
    return timestamp;
  }
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
