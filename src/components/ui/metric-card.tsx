/**
 * MetricCard - Unified component for displaying CPU/Memory metrics
 *
 * Provides consistent styling for resource usage visualization across the application.
 * Uses design system tokens for colors and animations.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  formatCPU,
  formatMemory,
  calculateUtilization,
  getUtilizationColor,
} from "@/lib/k8s-quantity";
import { Cpu, MemoryStick, Activity, HardDrive } from "lucide-react";

// ============================================================================
// MetricCard - Card display for metrics with progress bar
// ============================================================================

export interface MetricCardProps {
  /** Title for the metric card */
  title: string;
  /** Used value (millicores/bytes depending on type) */
  used: number | null | undefined;
  /** Request value for percentage calculation fallback */
  request?: number | null | undefined;
  /** Limit value (millicores/bytes depending on type) */
  limit?: number | null | undefined;
  /** Type of metric for parsing and formatting */
  type: "cpu" | "memory" | "storage" | "custom";
  /** Custom icon (defaults to CPU/Memory based on type) */
  icon?: React.ReactNode;
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
 * MetricCard - Full card component for displaying a metric
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
  icon,
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

  // Default icons based on type
  const defaultIcon =
    type === "cpu" ? (
      <Cpu className="h-4 w-4" />
    ) : type === "memory" ? (
      <MemoryStick className="h-4 w-4" />
    ) : type === "storage" ? (
      <HardDrive className="h-4 w-4" />
    ) : (
      <Activity className="h-4 w-4" />
    );

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
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <div className="flex items-center gap-2">
            {icon ?? defaultIcon}
            {title}
          </div>
          {showPercentage && percentage !== null && (
            <Badge
              variant={
                colorVariant === "destructive" ? "destructive" : "secondary"
              }
            >
              {percentage.toFixed(1)}%
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-bold">{usedDisplay}</span>
          <span className="text-sm text-muted-foreground">/ {baseDisplay}</span>
        </div>
        {showProgressBar && percentage !== null && (
          <Progress
            value={Math.min(100, percentage)}
            className={progressBarClass}
          />
        )}
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
        {hasRequest && hasLimit && (
          <p className="text-xs text-muted-foreground">
            Request: {format(requestNum!)}
          </p>
        )}
      </CardContent>
    </Card>
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
