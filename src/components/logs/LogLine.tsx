import { memo } from "react";
import type { LogLevel, LogLine as LogLineType } from "@/generated/types";
import { runSpanMs, type LogRun } from "./grouping";
import {
  ViewMode,
  HIDDEN_FIELD_KEYS,
  LEVEL_COLORS,
  LEVEL_MESSAGE_COLORS,
  LEVEL_WORDS,
  FORMAT_DESCRIPTIONS,
  formatCount,
  formatSpan,
  formatTimestamp,
  formatTimestampPrecise,
} from "./types";

/**
 * Time, a rule, then the line.
 *
 * Three fixed columns used to stand between the reader and the message —
 * a clipped clock, a three-letter level, and a format badge repeated on
 * every line of a stream that only ever has one format. What replaces
 * them is a 3px rule carrying the container and the message tinted by its
 * level: two channels in the width one of them used to take.
 *
 * Neither channel is colour-only. The container is named in the legend
 * above and again in the row's detail; the level is a word in the detail
 * and in the Table view, and it is what `level≥warn` filters on.
 */
const GRID = "grid grid-cols-[3.5rem_3px_minmax(0,1fr)] items-baseline gap-2";
const ROW = `${GRID} px-1.5 py-px hover:bg-hover`;

/** The clock, dim and fixed-width so the messages start on one axis. */
function Time({ timestamp }: { timestamp: string | null }) {
  return (
    <span className="text-right text-[11px] tabular-nums text-fg-fnt">
      {formatTimestamp(timestamp)}
    </span>
  );
}

/** The container's rule. `dim` marks a row that stands for many lines. */
function Gutter({ color, dim }: { color: string | undefined; dim?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`h-full self-stretch rounded-sm ${dim ? "opacity-50" : ""}`}
      style={{ background: color ?? "hsl(var(--fg-fnt))" }}
    />
  );
}

function visibleFieldsOf(log: LogLineType): [string, string][] {
  return log.fields
    ? Object.entries(log.fields).filter(([key]) => !HIDDEN_FIELD_KEYS.has(key))
    : [];
}

/**
 * Parsed fields, inline and dim, with the key as the thing you click.
 * Parsing them is only worth the cost if a question can be asked with
 * them, and this is where the asking starts.
 */
function Fields({
  fields,
  onFieldClick,
}: {
  fields: [string, string][];
  onFieldClick?: (key: string, value: string) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <span className="text-fg-fnt">
      {fields.map(([key, value]) => (
        <span key={key}>
          {" "}
          <button
            type="button"
            title={`Filter on ${key}=${value}`}
            className="text-fg-mut hover:text-info hover:underline hover:decoration-dotted"
            onClick={(event) => {
              event.stopPropagation();
              onFieldClick?.(key, value);
            }}
          >
            {key}
          </button>
          <span aria-hidden="true">=</span>
          {value}
        </span>
      ))}
    </span>
  );
}

interface LogLineProps {
  log: LogLineType;
  viewMode: ViewMode;
  searchQuery: string;
  containerColor: string | undefined;
  expanded: boolean;
  onToggleDetail: (id: number) => void;
  lineId: number;
  onFieldClick?: (key: string, value: string) => void;
  onLevelClick?: (level: LogLevel) => void;
}

export const LogLineComponent = memo(function LogLineComponent({
  log,
  viewMode,
  searchQuery,
  containerColor,
  expanded,
  onToggleDetail,
  lineId,
  onFieldClick,
  onLevelClick,
}: LogLineProps) {
  const level = log.level ?? "unknown";
  const messageColor = LEVEL_MESSAGE_COLORS[level];

  if (viewMode === "raw") {
    return (
      <div className="px-1.5 py-px hover:bg-hover">
        <span className="whitespace-pre-wrap break-all text-fg-mid">
          {searchQuery ? (
            <HighlightedText text={log.raw} query={searchQuery} />
          ) : (
            log.raw
          )}
        </span>
      </div>
    );
  }

  const fields = visibleFieldsOf(log);
  const message = searchQuery ? (
    <HighlightedText text={log.message} query={searchQuery} />
  ) : (
    log.message
  );

  return (
    <div>
      <div className={ROW}>
        <Time timestamp={log.timestamp} />
        <Gutter color={containerColor} />
        <span
          className={`block min-w-0 ${viewMode === "table" ? "break-all" : "truncate"}`}
        >
          {viewMode === "table" && (
            <button
              type="button"
              title={`Filter on level=${level}`}
              className={`mr-2 text-[10px] font-semibold uppercase tracking-wide hover:underline ${LEVEL_COLORS[level]}`}
              onClick={() => onLevelClick?.(level)}
            >
              {LEVEL_WORDS[level]}
            </button>
          )}
          <button
            type="button"
            title={expanded ? "Hide line detail" : "Show line detail"}
            aria-expanded={expanded}
            className={`text-left hover:underline hover:decoration-dotted ${messageColor}`}
            onClick={() => onToggleDetail(lineId)}
          >
            {message}
          </button>
          <Fields fields={fields} onFieldClick={onFieldClick} />
        </span>
      </div>
      {expanded && (
        <LineDetail
          log={log}
          fields={fields}
          containerColor={containerColor}
          onFieldClick={onFieldClick}
          onLevelClick={onLevelClick}
        />
      )}
    </div>
  );
});

/**
 * What the one-line row had to leave out: the whole message, the two
 * channels the row carries as colour said as words, and every field
 * including the ones the width cut off.
 */
function LineDetail({
  log,
  fields,
  containerColor,
  onFieldClick,
  onLevelClick,
}: {
  log: LogLineType;
  fields: [string, string][];
  containerColor: string | undefined;
  onFieldClick?: (key: string, value: string) => void;
  onLevelClick?: (level: LogLevel) => void;
}) {
  const level = log.level ?? "unknown";
  return (
    <div className="ml-16 mr-2 mb-1 mt-0.5 rounded border border-hair bg-hover px-2.5 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-fg-fnt">
        <span className="tabular-nums text-fg-mut">
          {formatTimestampPrecise(log.timestamp)}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-sm"
            style={{ background: containerColor ?? "hsl(var(--fg-fnt))" }}
          />
          <button
            type="button"
            title={`Filter on container=${log.container}`}
            className="text-fg-mut hover:text-info hover:underline hover:decoration-dotted"
            onClick={() => onFieldClick?.("container", log.container)}
          >
            {log.container}
          </button>
        </span>
        <button
          type="button"
          title={`Filter on level=${level}`}
          className={`hover:underline ${LEVEL_COLORS[level]}`}
          onClick={() => onLevelClick?.(level)}
        >
          level={LEVEL_WORDS[level]}
        </button>
        <span title={FORMAT_DESCRIPTIONS[log.format]}>{log.format}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap wrap-break-word font-mono text-fg-mid">
        {log.message}
      </p>
      {fields.length > 0 && (
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {fields.map(([key, value]) => (
            <div key={key} className="contents">
              <dt>
                <button
                  type="button"
                  title={`Filter on ${key}=${value}`}
                  className="text-fg-mut hover:text-info hover:underline hover:decoration-dotted"
                  onClick={() => onFieldClick?.(key, value)}
                >
                  {key}
                </button>
              </dt>
              <dd className="wrap-break-word text-fg-fnt">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * A run of consecutive repeats, standing in for the lines it collapsed.
 *
 * The count is plain dimmed text rather than a pill: it is a fact about
 * the row, not a badge to be scanned for, and 2 481 identical lines are
 * the least interesting thing on screen once you know how many there are.
 */
export const LogRunRow = memo(function LogRunRow({
  run,
  expanded,
  containerColor,
  onToggle,
}: {
  run: LogRun;
  expanded: boolean;
  containerColor: string | undefined;
  onToggle: (id: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(run.id)}
      className={`${ROW} w-full text-left`}
      aria-expanded={expanded}
      title={
        expanded
          ? "Collapse these repeats"
          : `Expand ${formatCount(run.count)} repeats`
      }
      data-testid="log-run"
    >
      <Time timestamp={run.head.timestamp} />
      <Gutter color={containerColor} dim />
      <span className="block min-w-0 truncate text-fg-mut">
        <span aria-hidden="true" className="mr-1 text-fg-fnt">
          {expanded ? "▾" : "▸"}
        </span>
        {run.head.message}{" "}
        <span className="text-fg-fnt">
          &times; {formatCount(run.count)} over {formatSpan(runSpanMs(run))}
        </span>
      </span>
    </button>
  );
});

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;

  // Build the parts array OUTSIDE the JSX so the try/catch wraps the
  // RegExp construction (the actual throwable) rather than the JSX
  // tree. JSX in try/catch trips react-hooks/error-boundaries
  // because rendering errors don't throw synchronously and the catch
  // wouldn't see them anyway.
  let parts: string[];
  try {
    parts = text.split(new RegExp(`(${escapeRegex(query)})`, "gi"));
  } catch {
    return <>{text}</>;
  }

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="rounded bg-warn/24 px-0.5 text-fg">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
