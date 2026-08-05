/**
 * RealtimeCountdown Component
 *
 * Displays an auto-updating countdown to a target date.
 * Useful for certificate expiry, token expiry, etc.
 *
 * @module components/ui/realtime/realtime-countdown
 */

import { memo } from "react";
import { useRealtimeCountdown } from "@/hooks/useRealtimeAge";
import { cn } from "@/lib/utils";

export interface RealtimeCountdownProps {
  /** Target date (ISO timestamp string or Date object) */
  target: string | Date | null | undefined;
  /** Additional CSS classes */
  className?: string;
  /** Prefix text (e.g., "Expires in ") */
  prefix?: string;
  /** Text to show when expired */
  expiredText?: string;
  /** Text to show when target is null/undefined */
  fallback?: string;
  /** Days before expiry to show warning styling (default: 7) */
  warningThresholdDays?: number;
  /** Days before expiry to show critical styling (default: 1) */
  criticalThresholdDays?: number;
  /** Whether to show warning colors */
  showWarningColors?: boolean;
}

/**
 * Auto-updating countdown display component
 *
 * @example
 * ```tsx
 * <RealtimeCountdown
 *   target={certificate.expiresAt}
 *   prefix="Expires in "
 *   showWarningColors
 * />
 * // Renders: "Expires in 2d 5h 30m" with color based on urgency
 * ```
 */
export const RealtimeCountdown = memo(function RealtimeCountdown({
  target,
  className,
  prefix = "",
  expiredText = "Expired",
  fallback = "-",
  warningThresholdDays = 7,
  criticalThresholdDays = 1,
  showWarningColors = true,
}: RealtimeCountdownProps) {
  const { display, isExpired, warningLevel } = useRealtimeCountdown(
    target ?? null,
    { warningThresholdDays, criticalThresholdDays }
  );

  if (!target) {
    return (
      <span className={cn("text-muted-foreground", className)}>{fallback}</span>
    );
  }

  const colorClass = showWarningColors
    ? warningLevel === "critical"
      ? "text-destructive font-medium"
      : warningLevel === "warning"
        ? "text-warn"
        : ""
    : "";

  if (isExpired) {
    return (
      <span className={cn("text-destructive font-medium", className)}>
        {expiredText}
      </span>
    );
  }

  return (
    <span className={cn(colorClass, className)}>
      {prefix}
      {display}
    </span>
  );
});
