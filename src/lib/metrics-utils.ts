// src/lib/metrics-utils.ts
import { formatCPU, formatMemory } from "./k8s-quantity";

/**
 * Metrics calculation utilities
 *
 * Provides smart percentage calculation and type-specific color thresholds.
 * CPU: warning at 80%, critical at 95% (throttling is tolerable)
 * Memory: warning at 70%, critical at 85% (OOMKill is dangerous)
 */

export type MetricType = "cpu" | "memory";
export type UtilizationLevel = "normal" | "warning" | "critical";
export type PercentageBase = "limit" | "request" | null;

export interface MetricState {
  /** Raw value in base units (millicores for CPU, bytes for memory) */
  value: number;
  /** Formatted display string (e.g., "256Mi", "500m") */
  displayValue: string;
  /** Percentage utilization (0-100) or null if no base available */
  percentage: number | null;
  /** What the percentage is calculated from */
  base: PercentageBase;
  /** Utilization level for color coding */
  level: UtilizationLevel;
  /** Whether a limit is configured */
  hasLimit: boolean;
  /** Whether a request is configured */
  hasRequest: boolean;
}

export interface MetricThresholds {
  warning: number;
  critical: number;
}

/**
 * Thresholds by metric type
 * CPU: Higher thresholds because throttling is tolerable
 * Memory: Lower thresholds because OOMKill is critical
 */
export const METRIC_THRESHOLDS: Record<MetricType, MetricThresholds> = {
  cpu: { warning: 80, critical: 95 },
  memory: { warning: 70, critical: 85 },
};

/**
 * Get thresholds for a metric type
 */
export function getThresholds(type: MetricType): MetricThresholds {
  return METRIC_THRESHOLDS[type];
}

/**
 * Calculate utilization level based on percentage and metric type
 */
export function getUtilizationLevel(
  percentage: number | null,
  type: MetricType
): UtilizationLevel {
  if (percentage === null) return "normal";

  const thresholds = getThresholds(type);

  if (percentage >= thresholds.critical) return "critical";
  if (percentage >= thresholds.warning) return "warning";
  return "normal";
}

/**
 * Calculate percentage with smart base selection
 * Priority: limit > request > null
 */
export function calculatePercentage(
  usage: number,
  request: number | null,
  limit: number | null
): { percentage: number | null; base: PercentageBase } {
  if (limit !== null && limit > 0) {
    return {
      percentage: Math.min(100, Math.max(0, (usage / limit) * 100)),
      base: "limit",
    };
  }

  if (request !== null && request > 0) {
    return {
      percentage: Math.min(999, Math.max(0, (usage / request) * 100)),
      base: "request",
    };
  }

  return { percentage: null, base: null };
}

/**
 * Calculate complete metric state from raw values
 *
 * @param type - Metric type ('cpu' or 'memory')
 * @param usage - Current usage (millicores for CPU, bytes for memory)
 * @param request - Requested resources (same units as usage)
 * @param limit - Resource limit (same units as usage)
 * @returns Complete metric state for rendering
 *
 * @example
 * // CPU with limit
 * calculateMetricState('cpu', 500, 250, 1000)
 * // → { value: 500, displayValue: "500m", percentage: 50, base: 'limit', level: 'normal', hasLimit: true, hasRequest: true }
 *
 * // Memory without limit
 * calculateMetricState('memory', 400 * 1024 * 1024, 256 * 1024 * 1024, null)
 * // → { value: 419430400, displayValue: "400Mi", percentage: 156, base: 'request', level: 'critical', hasLimit: false, hasRequest: true }
 */
export function calculateMetricState(
  type: MetricType,
  usage: number | null,
  request: number | null,
  limit: number | null
): MetricState | null {
  if (usage === null || usage === undefined) {
    return null;
  }

  const format = type === "cpu" ? formatCPU : formatMemory;
  const displayValue = format(usage);

  const { percentage, base } = calculatePercentage(usage, request, limit);
  const level = getUtilizationLevel(percentage, type);

  return {
    value: usage,
    displayValue,
    percentage,
    base,
    level,
    hasLimit: limit !== null && limit > 0,
    hasRequest: request !== null && request > 0,
  };
}

/**
 * Class per utilization level, one table per surface.
 *
 * "Normal" is deliberately uncoloured: on a page where most values are
 * fine, a green number on every row makes the one red number harder to
 * find, not easier. Colour marks the anomaly; the percentage is printed
 * either way, so the threshold never rides on hue alone.
 */
const LEVEL_TEXT: Record<UtilizationLevel, string> = {
  critical: "text-err",
  warning: "text-warn",
  normal: "",
};

const LEVEL_PROGRESS: Record<UtilizationLevel, string> = {
  critical: "[&>div]:bg-err",
  warning: "[&>div]:bg-warn",
  normal: "",
};

export function getLevelColorClass(level: UtilizationLevel): string {
  return LEVEL_TEXT[level];
}

/**
 * Get badge variant for utilization level
 */
export function getLevelBadgeVariant(
  level: UtilizationLevel
): "destructive" | "secondary" | "outline" {
  switch (level) {
    case "critical":
      return "destructive";
    case "warning":
      return "secondary";
    default:
      return "outline";
  }
}

export function getLevelProgressClass(level: UtilizationLevel): string {
  return LEVEL_PROGRESS[level];
}
