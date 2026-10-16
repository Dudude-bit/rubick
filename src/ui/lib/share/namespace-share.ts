import { Tag } from "lucide-react";

import type { NamespaceInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import { statusRole, type StatusRole } from "@/lib/status-role";

export function namespaceStatusOf(ns: NamespaceInfo): {
  text: string;
  role: StatusRole;
} {
  return { text: ns.status, role: statusRole(ns.status) };
}

export function namespaceLabelsSection(
  labels: Record<string, string>,
  t: T
): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = Object.entries(
    labels
  ).map(([key, value]) => ({
    label: key,
    values: [{ text: value, mono: true }],
  }));
  return {
    id: "labels",
    order: ORDER.own,
    title: t("columns", "labels"),
    icon: iconSvg(Tag),
    count: rows.length,
    body: { type: "facts", rows },
  };
}
