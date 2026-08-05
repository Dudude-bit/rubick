import type { LogFormat, LogLevel, LogLine } from "@/generated/types";

export type ViewMode = "compact" | "table" | "raw";

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

export { LogFormat, LogLevel, LogLine };
