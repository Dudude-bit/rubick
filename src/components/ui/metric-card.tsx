/**
 * MetricCard - Unified component for displaying CPU/Memory metrics
 *
 * Provides consistent styling for resource usage visualization across the application.
 * Uses design system tokens for colors and animations.
 */

import { cn } from "@/lib/utils";
import { Section, SectionHeader } from "@/components/ui/section";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  formatCPU,
  formatMemory,
  calculateUtilization,
  getUtilizationColor,
} from "@/lib/k8s-quantity";

// ============================================================================
// MetricCard - Metric readout with progress bar
// ============================================================================

export interface MetricCardProps {
  /** Title for the metric */
  title: string;
  /** Used value (millicores/bytes depending on type) */
  used: number | null | undefined;
  /** Request value for percentage calculation fallback */
  request?: number | null | undefined;
  /** Limit value (millicores/bytes depending on type) */
  limit?: number | null | undefined;
  /** Type of metric for parsing and formatting */
  type: "cpu" | "memory" | "storage" | "custom";
  /** Show progress bar */
  showProgressBar?: boolean;
  /** Show percentage badge */
  showPercentage?: boolean;
  /** Additional description */
  description?: string;
  /** Custom className */
  className?: string;
  /** Format function for custom type */
  formatValue?: (value: number) => string;
}

/**
 * MetricCard - Metric readout with a progress bar
 *
 * Uses type-specific thresholds:
 * - CPU: warning at 80%, critical at 95%
 * - Memory: warning at 70%, critical at 85%
 *
 * @example
 * <MetricCard
 *   title="CPU Usage"
 *   used={500}
 *   request={250}
 *   limit={2000}
 *   type="cpu"
 *   showProgressBar
 * />
 */
export function MetricCard({
  title,
  used,
  request,
  limit,
  type,
  showProgressBar = true,
  showPercentage = true,
  description,
  className,
  formatValue,
}: MetricCardProps) {
  const format =
    formatValue ??
    (type === "cpu"
      ? formatCPU
      : type === "memory" || type === "storage"
        ? formatMemory
        : (value: number) => `${value}`);

  const usedNum = typeof used === "number" ? used : null;
  const requestNum = typeof request === "number" ? request : null;
  const limitNum = typeof limit === "number" ? limit : null;

  const hasLimit = limitNum !== null && limitNum > 0;
  const hasRequest = requestNum !== null && requestNum > 0;

  // Smart percentage calculation: limit > request > null
  let percentage: number | null = null;

  if (usedNum !== null) {
    if (hasLimit) {
      percentage = calculateUtilization(usedNum, limitNum!);
    } else if (hasRequest) {
      percentage = Math.min(999, Math.max(0, (usedNum / requestNum!) * 100));
    }
  }

  const metricType =
    type === "cpu"
      ? "cpu"
      : type === "memory" || type === "storage"
        ? "memory"
        : undefined;
  const colorVariant = getUtilizationColor(percentage, metricType);

  // Format display values
  const usedDisplay = usedNum !== null ? format(usedNum) : "-";
  const baseDisplay = hasLimit
    ? format(limitNum!)
    : hasRequest
      ? `${format(requestNum!)} req`
      : "-";

  // Progress bar style: dashed when no limit
  const progressBarClass = cn(
    "h-2",
    colorVariant === "destructive" && "[&>div]:bg-err",
    colorVariant === "secondary" && "[&>div]:bg-warn",
    !hasLimit && hasRequest && "[&>div]:bg-opacity-60"
  );

  return (
    <Section className={className}>
      <SectionHeader
        title={title}
        actions={
          showPercentage &&
          percentage !== null && (
            <Badge
              variant={
                colorVariant === "destructive" ? "destructive" : "secondary"
              }
            >
              {percentage.toFixed(1)}%
            </Badge>
          )
        }
      />
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-bold tabular-nums">{usedDisplay}</span>
        <span className="text-sm text-fg-mut tabular-nums">
          / {baseDisplay}
        </span>
      </div>
      {showProgressBar && percentage !== null && (
        <Progress
          value={Math.min(100, percentage)}
          className={progressBarClass}
        />
      )}
      {description && <p className="text-xs text-fg-mut">{description}</p>}
      {hasRequest && hasLimit && (
        <p className="text-xs text-fg-mut">Request: {format(requestNum!)}</p>
      )}
    </Section>
  );
}

// ============================================================================
// MetricBadge - Compact inline metric display for tables
// ============================================================================

export interface MetricBadgeProps {
  /** Used value */
  used: number | null | undefined;
  /** Request value (for percentage calculation fallback) */
  request?: number | null | undefined;
  /** Limit value */
  limit?: number | null | undefined;
  /** Type of metric */
  type: "cpu" | "memory";
  /** Show percentage */
  showPercentage?: boolean;
  /** Custom className */
  className?: string;
}

/**
 * MetricBadge - Compact inline metric display with smart color coding
 *
 * Uses type-specific thresholds:
 * - CPU: warning at 80%, critical at 95%
 * - Memory: warning at 70%, critical at 85%
 *
 * @example
 * <MetricBadge used={500} request={250} limit={1000} type="cpu" />
 */
export function MetricBadge({
  used,
  request,
  limit,
  type,
  showPercentage = false,
  className,
}: MetricBadgeProps) {
  const format = type === "cpu" ? formatCPU : formatMemory;

  const usedNum = typeof used === "number" ? used : null;
  const requestNum = typeof request === "number" ? request : null;
  const limitNum = typeof limit === "number" ? limit : null;

  const hasLimit = limitNum !== null && limitNum > 0;
  const hasRequest = requestNum !== null && requestNum > 0;

  // Smart percentage calculation: limit > request > null
  let percentage: number | null = null;
  if (usedNum !== null) {
    if (hasLimit) {
      percentage = calculateUtilization(usedNum, limitNum!);
    } else if (hasRequest) {
      percentage = Math.min(999, Math.max(0, (usedNum / requestNum!) * 100));
    }
  }

  const colorVariant = getUtilizationColor(percentage, type);
  const usedDisplay = usedNum !== null ? format(usedNum) : "-";

  return (
    <Badge
      variant={
        colorVariant === "destructive"
          ? "destructive"
          : colorVariant === "secondary"
            ? "secondary"
            : "outline"
      }
      className={cn("font-mono text-xs", className)}
      title={
        usedNum !== null
          ? hasLimit
            ? `${usedDisplay} / ${format(limitNum!)} (${percentage?.toFixed(1)}% of limit)`
            : hasRequest
              ? `${usedDisplay} / ${format(requestNum!)} request (${percentage?.toFixed(1)}% of request)`
              : usedDisplay
          : undefined
      }
    >
      {usedDisplay}
      {showPercentage && percentage !== null && ` (${percentage.toFixed(0)}%)`}
    </Badge>
  );
}

export default MetricCard;
