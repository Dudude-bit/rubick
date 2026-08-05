/**
 * DataFreshness Component
 *
 * Displays a "Live" indicator showing data is being updated in real-time.
 *
 * @module components/ui/realtime/data-freshness
 */

import { memo } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface DataFreshnessProps {
  /** Timestamp when data was last fetched (from React Query's dataUpdatedAt) */
  dataUpdatedAt?: number;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Live data indicator component
 *
 * @example
 * ```tsx
 * <DataFreshness dataUpdatedAt={dataUpdatedAt} />
 * // Renders: ● Live
 * ```
 */
export const DataFreshness = memo(function DataFreshness({
  dataUpdatedAt,
  className,
}: DataFreshnessProps) {
  // Don't show if no data has been loaded yet
  if (!dataUpdatedAt) {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "inline-flex items-center gap-1.5 text-[11px] text-fg-fnt",
              className
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-ok" />
            <span>Live</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Data updates automatically</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
