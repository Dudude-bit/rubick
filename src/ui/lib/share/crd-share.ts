import { GitBranch, Info } from "lucide-react";

import type { CrdCondition, CrdDetailInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import {
  conditionsSection,
  ORDER,
  type PlacedSection,
} from "@/lib/report-parts";

export function crdFactsSection(crd: CrdDetailInfo, t: T): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "group"),
      values: [{ text: crd.group || "core", mono: true }],
    },
    { label: t("columns", "scope"), values: [{ text: crd.scope }] },
  ];
  return {
    id: "crd-facts",
    order: ORDER.own,
    title: t("nav", "definition"),
    icon: iconSvg(Info),
    body: { type: "facts", rows },
  };
}

export function crdVersionsSection(crd: CrdDetailInfo, t: T): PlacedSection {
  return {
    id: "crd-versions",
    order: ORDER.own,
    title: t("nav", "versions"),
    icon: iconSvg(GitBranch),
    count: crd.versions.length,
    body: {
      type: "table",
      columns: [
        t("columns", "version"),
        t("columns", "served"),
        t("columns", "storage"),
      ],
      rows: crd.versions.map((v) => ({
        cells: [
          { text: v.name, mono: true },
          {
            text: v.served ? t("action", "yes") : t("action", "no"),
            role: v.served ? "ok" : "warn",
          },
          {
            text: v.storage ? t("action", "yes") : t("action", "no"),
          },
        ],
      })),
      more: null,
    },
  };
}

/** The frame's own conditions reader only matches a `type` field; a CRD's carry `conditionType`. */
export function crdConditionsSection(
  conditions: CrdCondition[],
  t: T
): PlacedSection | null {
  if (conditions.length === 0) return null;
  return conditionsSection(
    conditions.map((c) => ({
      type: c.conditionType,
      status: c.status,
      reason: c.reason,
      message: c.message,
      lastTransitionTime: c.lastTransitionTime,
    })),
    t
  );
}
