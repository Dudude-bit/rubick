import { Bell } from "lucide-react";

import { iconSvg } from "@/lib/icon-svg";
import type { ReportFinding } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { T } from "@/i18n/useT";
import { rowWords } from "./words";
import type { RuleRow } from "./model";

/** The rule objects actually firing or pending, as the reader came to see. */
export function alertsSection(
  rows: RuleRow[] | null,
  t: T
): PlacedSection | null {
  if (!rows) return null;
  const found: ReportFinding[] = rows
    .filter((row) => row.group === "firing" || row.group === "pending")
    .map((row) => ({
      title: row.object.name,
      detail: rowWords(row, t),
      role: row.group === "firing" ? "err" : "warn",
      ref: refOf({
        kind: "PrometheusRule",
        name: row.object.name,
        namespace: row.object.namespace,
      }),
    }));
  if (found.length === 0) return null;
  return {
    id: "prometheus-alerts",
    order: ORDER.own,
    title: t("alerts", "tabAlerts"),
    icon: iconSvg(Bell),
    count: found.length,
    body: { type: "findings", items: found },
  };
}
