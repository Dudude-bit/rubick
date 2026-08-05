/**
 * Pure helpers behind the table's quantity cells.
 *
 * Kept out of the component file so they can be exercised directly — both
 * are easy to get subtly wrong, and both are read on every row of every
 * resource table.
 */

/**
 * Splits a formatted quantity into its numeric head and unit tail.
 *
 * Deliberately string-level: the formatters already decided the scale
 * ("1.81Gi", "999m", "2.5"), and re-deriving the unit from the raw number
 * would let the two disagree. A value with no unit returns an empty tail,
 * and anything unparseable (a dash, "n/a") comes back whole so the caller
 * can still render it.
 */
export function splitUnit(formatted: string): { value: string; unit: string } {
  const match = /^(-?[\d.]+)\s*([^\d\s]*)$/.exec(formatted.trim());
  if (!match) return { value: formatted, unit: "" };
  return { value: match[1], unit: match[2] };
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
