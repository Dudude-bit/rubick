import { createContext, useContext } from "react";

import type { MetricsStatus, MetricsStatusKind } from "@/generated/types";

/** Why there are no CPU and memory figures, when there are none. */
export type MetricsAbsence = Exclude<MetricsStatusKind, "available">;

export function absenceOf(
  status: MetricsStatus | null | undefined
): MetricsAbsence | null {
  if (!status || status.status === "available") return null;
  // Anything this build has no word for is a failure, never "available".
  return status.status === "notInstalled" || status.status === "forbidden"
    ? status.status
    : "error";
}

/**
 * Not installed and refused do not change by being asked every two seconds,
 * and a refused read lands in the audit log under the reader's name each
 * time. A failing API might come back, so it keeps the usual rate.
 */
export function isUnserved(status: MetricsStatus | null | undefined): boolean {
  const absence = absenceOf(status);
  return absence === "notInstalled" || absence === "forbidden";
}

/** The few words a cell or a usage row has room for, per reason. */
export const ABSENCE_SHORT = {
  notInstalled: "metricsShortNotInstalled",
  forbidden: "metricsShortForbidden",
  error: "metricsShortError",
} as const satisfies Record<MetricsAbsence, string>;

/**
 * Why the metrics under it are missing, for cells and rows built once at
 * module level that cannot be handed the page's status as a prop.
 */
export const MetricsAbsenceContext = createContext<MetricsAbsence | null>(null);

export function useMetricsAbsence(): MetricsAbsence | null {
  return useContext(MetricsAbsenceContext);
}
