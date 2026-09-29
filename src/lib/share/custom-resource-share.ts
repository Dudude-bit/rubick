import { Activity, GitFork, Info } from "lucide-react";

import type {
  CustomResourceDetailInfo,
  OwnerReferenceInfo,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";

export function customResourceFactsSection(
  resource: CustomResourceDetailInfo,
  t: T
): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "apiVersion"),
      values: [{ text: resource.apiVersion, mono: true }],
    },
    {
      label: t("columns", "kind"),
      values: [{ text: resource.kind, mono: true }],
    },
  ];
  return {
    id: "cr-facts",
    order: ORDER.own,
    title: t("columns", "object"),
    icon: iconSvg(Info),
    body: { type: "facts", rows },
  };
}

export function ownersSection(
  owners: OwnerReferenceInfo[],
  namespace: string | null,
  t: T
): PlacedSection | null {
  if (owners.length === 0) return null;
  return {
    id: "owners",
    order: ORDER.own,
    title: t("columns", "ownedBy"),
    icon: iconSvg(GitFork),
    count: owners.length,
    body: {
      type: "facts",
      rows: owners.map((owner) => ({
        label: owner.controller
          ? `${owner.kind} · ${t("empty", "controllerLower")}`
          : owner.kind,
        values: [
          {
            text: owner.name,
            ref: refOf({ kind: owner.kind, name: owner.name, namespace }),
          },
        ],
      })),
    },
  };
}

function isConditionShape(
  value: unknown
): value is { type: string; status: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof (entry as { type?: unknown })?.type === "string" &&
        typeof (entry as { status?: unknown })?.status === "string"
    )
  );
}

/**
 * The frame already draws `status.conditions` when it has that shape; this is
 * only the fallback for an operator that reports health some other way, e.g.
 * `status.phase` or `status.ready`.
 */
export function statusSummarySection(
  status: unknown,
  t: T
): PlacedSection | null {
  if (status === null || typeof status !== "object") return null;
  const record = status as Record<string, unknown>;
  if (isConditionShape(record.conditions)) return null;
  const rows: { label: string; values: ReportValue[] }[] = Object.entries(
    record
  )
    .filter(
      ([key, value]) =>
        key !== "conditions" &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean")
    )
    .map(([key, value]) => ({
      label: key,
      values: [{ text: String(value), mono: typeof value !== "string" }],
    }));
  if (rows.length === 0) return null;
  return {
    id: "status-summary",
    order: ORDER.own,
    title: t("columns", "status"),
    icon: iconSvg(Activity),
    body: { type: "facts", rows },
  };
}
