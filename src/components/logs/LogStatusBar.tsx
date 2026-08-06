import { useMemo } from "react";
import type { LogLine, LogFormat } from "@/generated/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FORMAT_DESCRIPTIONS } from "./types";

interface LogStatusBarProps {
  logs: LogLine[];
  /** Lines held right now, and the cap they are held against. */
  retained: number;
  limit: number;
  /** Evicted from the head since the stream started; > 0 means lossy. */
  dropped: number;
  filteredCount: number;
  /** Lines standing behind a collapsed run rather than drawn on their own. */
  collapsedCount: number;
  isStreaming: boolean;
}

export function LogStatusBar({
  logs,
  retained,
  limit,
  dropped,
  filteredCount,
  collapsedCount,
  isStreaming,
}: LogStatusBarProps) {
  const formatInfo = useMemo(() => {
    if (logs.length === 0) return null;

    const formatCounts = new Map<string, number>();
    for (const log of logs) {
      const format = log.format ?? "plain";
      formatCounts.set(format, (formatCounts.get(format) ?? 0) + 1);
    }

    if (formatCounts.size === 1) {
      const format = formatCounts.keys().next().value as LogFormat;
      return {
        format,
        label: format,
        description: FORMAT_DESCRIPTIONS[format],
      };
    }

    // Find dominant format
    let maxFormat: LogFormat = "plain";
    let maxCount = 0;
    for (const [format, count] of formatCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxFormat = format as LogFormat;
      }
    }

    const percentage = Math.round((maxCount / logs.length) * 100);
    if (percentage >= 90) {
      return {
        format: maxFormat,
        label: `${maxFormat} (${percentage}%)`,
        description: FORMAT_DESCRIPTIONS[maxFormat],
      };
    }

    return {
      format: "mixed" as const,
      label: "mixed",
      description: "Logs contain multiple formats",
    };
  }, [logs]);

  return (
    <div className="flex items-center justify-between border-t border-hair px-4 py-1.5 text-xs text-fg-mut">
      <span>
        {retained.toLocaleString()}{" "}
        <span className="text-fg-fnt">of {limit.toLocaleString()} kept</span>
        {/* The head being dropped was silent until now: the pane looked
            like the whole log and was not. */}
        {dropped > 0 && (
          <span className="text-warn">
            {" "}
            · {dropped.toLocaleString()} older dropped
          </span>
        )}
      </span>
      <div className="flex items-center gap-4">
        <span className="text-fg-fnt">
          {filteredCount.toLocaleString()} shown
          {retained !== filteredCount &&
            ` · ${(retained - filteredCount).toLocaleString()} filtered out`}
          {collapsedCount > 0 &&
            ` · ${collapsedCount.toLocaleString()} in collapsed repeats`}
        </span>
        {formatInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="capitalize cursor-help">
                format: {formatInfo.label}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{formatInfo.description}</TooltipContent>
          </Tooltip>
        )}
        {isStreaming && (
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
            Streaming
          </span>
        )}
      </div>
    </div>
  );
}
