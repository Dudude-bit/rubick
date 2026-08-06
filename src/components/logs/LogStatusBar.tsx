import { useEffect, useMemo, useState } from "react";
import type { LogLine, LogFormat } from "@/generated/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FORMAT_DESCRIPTIONS } from "./types";

// TEMP INSTRUMENTATION - remove before commit
function DomProbe() {
  const [n, setN] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    const t = setInterval(() => {
      const list = document.querySelector("[data-log-list]");
      setN([
        list ? list.querySelectorAll("*").length : -1,
        document.getElementsByTagName("*").length,
      ]);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span data-testid="dom-probe">
      dom: {n[0]} / {n[1]}
    </span>
  );
}

interface LogStatusBarProps {
  logs: LogLine[];
  filteredCount: number;
  isStreaming: boolean;
  searchQuery: string;
}

export function LogStatusBar({
  logs,
  filteredCount,
  isStreaming,
  searchQuery,
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
        {filteredCount} {filteredCount === 1 ? "line" : "lines"}
        {searchQuery && logs.length !== filteredCount && (
          <span> (filtered from {logs.length})</span>
        )}
      </span>
      <div className="flex items-center gap-4">
        <DomProbe />
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
