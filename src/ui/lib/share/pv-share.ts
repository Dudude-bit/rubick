import { Database } from "lucide-react";

import type { PersistentVolumeInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { statusRole, type StatusRole } from "@/lib/status-role";

export function pvStatusOf(
  pv: PersistentVolumeInfo
): { text: string; role: StatusRole } | null {
  return pv.status ? { text: pv.status, role: statusRole(pv.status) } : null;
}

/** `spec.claimRef` arrives serialised as `namespace/name`, the same as `ClaimRef` reads it. */
function claimValue(claim: string): ReportValue {
  const slash = claim.indexOf("/");
  const namespace = slash === -1 ? null : claim.slice(0, slash);
  const name = slash === -1 ? claim : claim.slice(slash + 1);
  return {
    text: name,
    ref: refOf({ kind: "PersistentVolumeClaim", name, namespace }),
  };
}

export function pvFactsSection(pv: PersistentVolumeInfo, t: T): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "capacity"),
      values: [{ text: pv.capacity ?? "–", mono: true }],
    },
    {
      label: t("columns", "accessModes"),
      values: [
        {
          text: pv.accessModes.length
            ? pv.accessModes.join(" · ")
            : t("empty", "none"),
          mono: true,
        },
      ],
    },
    {
      label: t("columns", "claim"),
      values: [
        pv.claim
          ? claimValue(pv.claim)
          : { text: t("empty", "pvUnbound"), role: "warn" },
      ],
    },
    {
      label: t("columns", "storageClass"),
      values: [
        pv.storageClass
          ? {
              text: pv.storageClass,
              ref: refOf({
                kind: "StorageClass",
                name: pv.storageClass,
                namespace: null,
              }),
            }
          : { text: t("empty", "none") },
      ],
    },
    {
      label: t("columns", "reclaimPolicy"),
      values: [{ text: pv.reclaimPolicy ?? "–", mono: true }],
    },
    ...(pv.reason
      ? [
          {
            label: t("columns", "reason"),
            values: [{ text: pv.reason, role: "err" as const }],
          },
        ]
      : []),
  ];
  return {
    id: "pv-facts",
    order: ORDER.own,
    title: t("columns", "volume"),
    icon: iconSvg(Database),
    body: { type: "facts", rows },
  };
}
