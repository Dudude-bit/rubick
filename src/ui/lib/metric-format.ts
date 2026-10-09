import type { T } from "@/i18n/useT";
import { formatBytes, formatCPU, parseQuantity } from "@/lib/k8s-quantity";
import type { ReportValue } from "@/lib/report";

/**
 * Pure helpers behind the table's quantity cells.
 *
 * Kept out of the component file so they can be exercised directly: both are
 * easy to get subtly wrong, and both are read on every row of every table.
 */

/**
 * Splits a formatted quantity into its numeric head and unit tail.
 *
 * Deliberately string-level: the formatters already decided the scale
 * ("1.81Gi", "999m", "2.5"), and re-deriving the unit from the raw number
 * would let the two disagree. The tail keeps the space a language puts
 * before its unit («1,8 ГиБ»). A value with no unit returns an empty tail,
 * and anything unparseable (a dash, "n/a") comes back whole so the caller
 * can still render it.
 */
export function splitUnit(formatted: string): { value: string; unit: string } {
  const match = /^(-?\d[\d.,]*)(\s?[^\d\s][^\d]*)?$/.exec(formatted.trim());
  if (!match) return { value: formatted, unit: "" };
  return { value: match[1], unit: match[2] ?? "" };
}

/**
 * What a usage number is measured in. `count` is a plain tally of things;
 * `throughput` is bytes per second, which is memory's formatter plus the
 * `/s` that stops 12Mi of traffic reading as 12Mi of resident memory.
 */
export type QuantityKind = "cpu" | "memory" | "count" | "throughput";

/**
 * A usage number at the scale its unit deserves.
 *
 * Shared by the bar rows and the charts so a pod cannot read "96Mi" in one
 * block and "96.0Mi" in the one below it.
 */
export function formatQuantity(
  value: number,
  kind: QuantityKind,
  unit?: string
): string {
  if (kind === "cpu") return formatCPU(value);
  if (kind === "memory") return formatBytes(value, { trim: true });
  if (kind === "throughput") return `${formatBytes(value, { trim: true })}/s`;
  return `${Math.round(value)}${unit ?? ""}`;
}

/** A request or limit as every reader spells it; one with no unit of its own, or that does not parse, as written. */
export function declaredQuantity(resource: string, raw: string): string {
  const value = parseQuantity(raw);
  if (value === null) return raw;
  if (resource === "cpu") return formatCPU(value * 1000);
  if (
    resource === "memory" ||
    resource === "ephemeral-storage" ||
    resource.startsWith("hugepages-")
  )
    return formatBytes(value, { trim: true });
  return raw;
}

export type UsageRole = "ok" | "warn" | "err";

/**
 * Colour role for a used/limit ratio. Thresholds are exclusive: exactly
 * 90% is still `warn` and exactly 75% is still `ok` — a bar should not
 * turn red the instant a pod touches a round number.
 */
export function usageRole(ratio: number): UsageRole {
  if (ratio > 0.9) return "err";
  if (ratio > 0.75) return "warn";
  return "ok";
}

/**
 * Two decimals turn a column of memory into "320.00Ki, 336.00Ki" — noise
 * that reads as precision. One decimal separates any two pods worth
 * separating, and a trailing `.0` carries nothing.
 */
export function formatUsage(value: number, type: "cpu" | "memory"): string {
  return formatQuantity(value, type);
}

/** A shared usage nobody measured: neither zero nor "none". */
export const notMeasured = (t: T): ReportValue => ({
  text: t("cluster", "metricNotAvailable"),
  quiet: true,
});
