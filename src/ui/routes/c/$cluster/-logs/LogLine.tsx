import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { memo } from "react";
import type { LogLevel, LogLine as LogLineType } from "@/generated/types";
import { messageSegments } from "./ansi";
import { AnsiText, Marked } from "./AnsiText";
import { runSpanMs, type LogRun } from "./grouping";
import {
  ViewMode,
  HIDDEN_FIELD_KEYS,
  LEVEL_COLORS,
  LEVEL_MESSAGE_COLORS,
  LEVEL_WORDS,
  FORMAT_DESCRIPTIONS,
  formatSpan,
  formatTimestamp,
  formatTimestampPrecise,
  matchedOutsideMessage,
  stampLength,
} from "./types";
import { formatCount } from "@/lib/count";

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
  query,
  onFieldClick,
}: {
  fields: [string, string][];
  query: string;
  onFieldClick?: (key: string, value: string) => void;
}) {
  const t = useT();
  if (fields.length === 0) return null;
  return (
    <span className="text-fg-fnt">
      {fields.map(([key, value]) => (
        <span key={key}>
          {" "}
          <button
            type="button"
            title={t("action", "filterOn", { key, value })}
            className="text-fg-mut hover:text-info hover:underline hover:decoration-dotted"
            onClick={(event) => {
              event.stopPropagation();
              onFieldClick?.(key, value);
            }}
          >
            <Marked text={key} query={query} />
          </button>
          <span aria-hidden="true">=</span>
          <Marked text={value} query={query} />
        </span>
      ))}
    </span>
  );
}

/**
 * The search found the line somewhere the row does not draw: the fields
 * that hold it, named in the highlight's colour, or the raw line.
 */
function MatchedIn({ fields }: { fields: string[] }) {
  const t = useT();
  return (
    <span className="ml-2 text-[10px] text-fg-fnt" data-testid="log-matched-in">
      {fields.length === 0
        ? t("empty", "matchedOutsideMessage")
        : parts(t("empty", "matchedIn"), {
            fields: fields.map((key, index) => (
              <span key={key}>
                {index > 0 && ", "}
                <mark className="rounded bg-warn/24 px-0.5 font-mono text-fg">
                  {key}
                </mark>
              </span>
            )),
          })}
    </span>
  );
}

/**
 * The message in the colours the program wrote it in, where the runs are
 * known. Unstyled text inherits the level tint from the row, so a line
 * that only coloured its level word is still tinted as a whole.
 */
function Message({ log, query = "" }: { log: LogLineType; query?: string }) {
  const segments = messageSegments(log);
  return segments ? (
    <AnsiText segments={segments} query={query} />
  ) : (
    <Marked text={log.message} query={query} />
  );
}

interface LogLineProps {
  log: LogLineType;
  viewMode: ViewMode;
  searchQuery: string;
  containerColor: string | undefined;
  /** The lane's name, where the pane reads more than one pod. */
  laneLabel?: string | null;
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
  laneLabel = null,
  expanded,
  onToggleDetail,
  lineId,
  onFieldClick,
  onLevelClick,
}: LogLineProps) {
  const t = useT();
  const level = log.level ?? "unknown";
  const messageColor = LEVEL_MESSAGE_COLORS[level];

  if (viewMode === "raw") {
    const skip = stampLength(log);
    return (
      <div className="px-1.5 py-px hover:bg-hover">
        <span className="whitespace-pre-wrap break-all text-fg-mid">
          {log.segments ? (
            <AnsiText segments={log.segments} query={searchQuery} skip={skip} />
          ) : (
            <Marked text={log.raw} query={searchQuery} skip={skip} />
          )}
        </span>
      </div>
    );
  }

  const fields = visibleFieldsOf(log);
  const message = <Message log={log} query={searchQuery} />;
  const outside = matchedOutsideMessage(log, searchQuery);
  const unshown =
    outside !== null && !fields.some(([key]) => outside.includes(key))
      ? outside
      : null;

  return (
    <div>
      <div className={ROW}>
        <Time timestamp={log.timestamp} />
        <Gutter color={containerColor} />
        <span
          className={`block min-w-0 ${viewMode === "table" ? "break-all" : "truncate"}`}
        >
          {laneLabel !== null && (
            <LaneLabel
              label={laneLabel}
              color={containerColor}
              pod={log.pod}
              onFieldClick={onFieldClick}
            />
          )}
          {viewMode === "table" && (
            <button
              type="button"
              title={t("action", "filterOn", {
                key: "level",
                value: LEVEL_WORDS[level],
              })}
              className={`mr-2 text-[10px] font-semibold uppercase tracking-wide hover:underline ${LEVEL_COLORS[level]}`}
              onClick={() => onLevelClick?.(level)}
            >
              {LEVEL_WORDS[level]}
            </button>
          )}
          <button
            type="button"
            title={
              expanded
                ? t("empty", "hideLineDetail")
                : t("empty", "showLineDetail")
            }
            aria-expanded={expanded}
            className={`text-left hover:underline hover:decoration-dotted ${messageColor}`}
            onClick={() => onToggleDetail(lineId)}
          >
            {message}
          </button>
          <Fields
            fields={fields}
            query={searchQuery}
            onFieldClick={onFieldClick}
          />
          {unshown && <MatchedIn fields={unshown} />}
        </span>
      </div>
      {expanded && (
        <LineDetail
          log={log}
          query={searchQuery}
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
  query,
  fields,
  containerColor,
  onFieldClick,
  onLevelClick,
}: {
  log: LogLineType;
  query: string;
  fields: [string, string][];
  containerColor: string | undefined;
  onFieldClick?: (key: string, value: string) => void;
  onLevelClick?: (level: LogLevel) => void;
}) {
  const t = useT();
  const level = log.level ?? "unknown";
  return (
    <div className="ml-16 mr-2 mb-1 mt-0.5 rounded border border-hair bg-hover px-2.5 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-fg-fnt">
        <span className="tabular-nums text-fg-mut">
          {formatTimestampPrecise(log.timestamp, t)}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-sm"
            style={{ background: containerColor ?? "hsl(var(--fg-fnt))" }}
          />
          <button
            type="button"
            title={t("action", "filterOn", {
              key: "container",
              value: log.container,
            })}
            className="text-fg-mut hover:text-info hover:underline hover:decoration-dotted"
            onClick={() => onFieldClick?.("container", log.container)}
          >
            {log.container}
          </button>
        </span>
        <button
          type="button"
          title={t("action", "filterOn", { key: "pod", value: log.pod })}
          className="text-fg-mut hover:text-info hover:underline hover:decoration-dotted"
          onClick={() => onFieldClick?.("pod", log.pod)}
        >
          {log.pod}
        </button>
        <button
          type="button"
          title={t("action", "filterOn", {
            key: "level",
            value: LEVEL_WORDS[level],
          })}
          className={`hover:underline ${LEVEL_COLORS[level]}`}
          onClick={() => onLevelClick?.(level)}
        >
          level={LEVEL_WORDS[level]}
        </button>
        <span title={t("readings", FORMAT_DESCRIPTIONS[log.format])}>
          {log.format}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap wrap-break-word font-mono text-fg-mid">
        <Message log={log} query={query} />
      </p>
      {fields.length > 0 && (
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {fields.map(([key, value]) => (
            <div key={key} className="contents">
              <dt>
                <button
                  type="button"
                  title={t("action", "filterOn", { key, value })}
                  className="text-fg-mut hover:text-info hover:underline hover:decoration-dotted"
                  onClick={() => onFieldClick?.(key, value)}
                >
                  <Marked text={key} query={query} />
                </button>
              </dt>
              <dd className="wrap-break-word text-fg-fnt">
                <Marked text={value} query={query} />
              </dd>
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
/** The pod a line came from, in the lane's colour, and a filter on it. */
function LaneLabel({
  label,
  color,
  pod,
  onFieldClick,
}: {
  label: string;
  color: string | undefined;
  pod: string;
  onFieldClick?: (key: string, value: string) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      title={t("action", "filterOn", { key: "pod", value: pod })}
      className="mr-2 text-[10px] font-semibold hover:underline"
      style={{ color: color ?? "hsl(var(--fg-fnt))" }}
      onClick={() => onFieldClick?.("pod", pod)}
    >
      {label}
    </button>
  );
}

export const LogRunRow = memo(function LogRunRow({
  run,
  expanded,
  containerColor,
  laneLabel = null,
  searchQuery,
  onToggle,
}: {
  run: LogRun;
  expanded: boolean;
  searchQuery: string;
  containerColor: string | undefined;
  laneLabel?: string | null;
  onToggle: (id: number) => void;
}) {
  const t = useT();
  const outside = matchedOutsideMessage(run.head, searchQuery);
  return (
    <button
      type="button"
      onClick={() => onToggle(run.id)}
      className={`${ROW} w-full text-left`}
      aria-expanded={expanded}
      title={
        expanded
          ? t("empty", "collapseRepeats")
          : t("empty", "expandRepeats", { count: formatCount(run.count) })
      }
      data-testid="log-run"
    >
      <Time timestamp={run.head.timestamp} />
      <Gutter color={containerColor} dim />
      <span className="block min-w-0 truncate text-fg-mut">
        {laneLabel !== null && (
          <span
            className="mr-2 text-[10px] font-semibold"
            style={{ color: containerColor ?? "hsl(var(--fg-fnt))" }}
          >
            {laneLabel}
          </span>
        )}
        <span aria-hidden="true" className="mr-1 text-fg-fnt">
          {expanded ? "▾" : "▸"}
        </span>
        <Message log={run.head} query={searchQuery} />{" "}
        <span className="text-fg-fnt">
          {runSpanMs(run) > 0
            ? t("count", "runOverSpan", {
                count: formatCount(run.count),
                span: formatSpan(runSpanMs(run)),
              })
            : t("count", "runAtOnce", { count: formatCount(run.count) })}
        </span>
        {outside && <MatchedIn fields={outside} />}
      </span>
    </button>
  );
});
