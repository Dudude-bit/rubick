/**
 * RealtimeAge Component
 *
 * Displays an auto-updating age value with adaptive refresh intervals.
 * Uses the global tick store for efficient batched updates.
 *
 * @module components/ui/realtime/realtime-age
 */

import { memo } from "react";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { cn } from "@/lib/utils";

export interface RealtimeAgeProps {
  /** ISO timestamp string or null */
  timestamp: string | null | undefined;
  /** Additional CSS classes */
  className?: string;
  /** Text to show when timestamp is null/undefined */
  fallback?: string;
}

/**
 * Auto-updating age display component
 *
 * @example
 * ```tsx
 * <RealtimeAge timestamp={pod.createdAt} />
 * // Renders: "5m" and auto-updates based on age
 * ```
 */
export const RealtimeAge = memo(function RealtimeAge({
  timestamp,
  className,
  fallback = "Unknown",
}: RealtimeAgeProps) {
  const age = useRealtimeAge(timestamp ?? null);

  if (!timestamp) {
    return <span className={cn("text-fg-fnt", className)}>{fallback}</span>;
  }

  return <span className={className}>{age}</span>;
});
