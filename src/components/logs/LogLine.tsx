import { memo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { LogLine as LogLineType } from "@/generated/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { runSpanMs, type LogRun } from "./grouping";
import {
  ViewMode,
  HIDDEN_FIELD_KEYS,
  LEVEL_LABELS,
  LEVEL_COLORS,
  LEVEL_BORDER_COLORS,
  FORMAT_DESCRIPTIONS,
  formatSpan,
  formatTimestamp,
} from "./types";

/** Shared shell for the table and compact rows; only the rule colour differs. */
const ROW =
  "flex gap-3 rounded border-l-2 px-1 py-0.5 pl-2 transition-colors hover:bg-hover";

interface LogLineProps {
  log: LogLineType;
  viewMode: ViewMode;
  searchQuery: string;
  onFieldClick?: (key: string, value: string) => void;
  onLevelClick?: (level: string) => void;
}

export const LogLineComponent = memo(function LogLineComponent({
  log,
  viewMode,
  searchQuery,
  onFieldClick,
  onLevelClick,
}: LogLineProps) {
  const level = log.level ?? "unknown";
  const levelLabel = LEVEL_LABELS[level];
  const levelColor = LEVEL_COLORS[level];
  const borderColor = LEVEL_BORDER_COLORS[level];

  if (viewMode === "raw") {
    return (
      <div className="rounded px-1 py-0.5 hover:bg-hover">
        <span className="whitespace-pre-wrap break-all">
          {searchQuery ? (
            <HighlightedText text={log.raw} query={searchQuery} />
          ) : (
            log.raw
          )}
        </span>
      </div>
    );
  }

  const visibleFields = log.fields
    ? Object.entries(log.fields).filter(([key]) => !HIDDEN_FIELD_KEYS.has(key))
    : [];

  if (viewMode === "table") {
    return (
      <div className={`${ROW} ${borderColor}`}>
        <span className="w-20 shrink-0 text-fg-fnt">
          {formatTimestamp(log.timestamp)}
        </span>
        <span
          className={`shrink-0 w-8 text-[10px] font-semibold tracking-wide uppercase cursor-pointer hover:underline ${levelColor}`}
          onClick={() => onLevelClick?.(level)}
        >
          {levelLabel}
        </span>
        <div className="flex-1 min-w-0">
          <span className="whitespace-pre-wrap break-all">
            {searchQuery ? (
              <HighlightedText text={log.message} query={searchQuery} />
            ) : (
              log.message
            )}
          </span>
        </div>
        {visibleFields.length > 0 && (
          <div className="flex max-w-xs shrink-0 flex-wrap gap-2 text-[10px] text-fg-fnt">
            {visibleFields.slice(0, 3).map(([key, value]) => (
              <span
                key={key}
                className="flex cursor-pointer items-baseline gap-1 hover:text-fg"
                onClick={() => onFieldClick?.(key, value)}
              >
                <span className="text-fg-mut">{key}</span>
                <span className="max-w-[100px] truncate">{value}</span>
              </span>
            ))}
            {visibleFields.length > 3 && (
              <span className="text-fg-fnt">+{visibleFields.length - 3}</span>
            )}
          </div>
        )}
      </div>
    );
  }

  // Compact mode (default)
  return (
    <div className={`${ROW} ${borderColor}`}>
      <span className="w-20 shrink-0 text-fg-fnt">
        {formatTimestamp(log.timestamp)}
      </span>
      <span
        className={`shrink-0 w-8 text-[10px] font-semibold tracking-wide uppercase cursor-pointer hover:underline ${levelColor}`}
        onClick={() => onLevelClick?.(level)}
      >
        {levelLabel}
      </span>
      {log.format !== "plain" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 cursor-help text-[10px] uppercase text-fg-fnt">
              {log.format}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {FORMAT_DESCRIPTIONS[log.format]}
          </TooltipContent>
        </Tooltip>
      )}
      <div className="flex flex-col gap-1 w-full min-w-0">
        <span className="whitespace-pre-wrap break-all">
          {searchQuery ? (
            <HighlightedText text={log.message} query={searchQuery} />
          ) : (
            log.message
          )}
        </span>
        {visibleFields.length > 0 && (
          <div className="flex flex-wrap gap-2 text-[10px] text-fg-fnt">
            {visibleFields.map(([key, value]) => (
              <span
                key={key}
                className="flex cursor-pointer items-baseline gap-1 hover:text-fg"
                onClick={() => onFieldClick?.(key, value)}
              >
                <span className="text-fg-mut">{key}</span>
                <span className="break-all">{value}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * A run of consecutive repeats, standing in for the lines it collapsed.
 * Deliberately plain — the count and the span are the facts it owes the
 * reader, and the styling is the next change's business.
 */
export const LogRunRow = memo(function LogRunRow({
  run,
  expanded,
  onToggle,
}: {
  run: LogRun;
  expanded: boolean;
  onToggle: (id: number) => void;
}) {
  const Caret = expanded ? ChevronDown : ChevronRight;

  return (
    <button
      type="button"
      onClick={() => onToggle(run.id)}
      className={`${ROW} w-full border-transparent text-left`}
      aria-expanded={expanded}
      data-testid="log-run"
    >
      <span className="w-20 shrink-0 text-fg-fnt">
        {formatTimestamp(run.head.timestamp)}
      </span>
      <Caret className="mt-0.5 h-3 w-3 shrink-0 text-fg-fnt" />
      <span className="min-w-0 flex-1 truncate text-fg-mut">
        {run.head.message}
      </span>
      <span className="shrink-0 text-fg-mid">&times;{run.count}</span>
      <span className="shrink-0 text-fg-fnt">
        over {formatSpan(runSpanMs(run))}
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
          <mark key={i} className="rounded bg-warn/[0.24] px-0.5 text-fg">
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
