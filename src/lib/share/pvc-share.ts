import { Database } from "lucide-react";

import type { PersistentVolumeClaimInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { statusRole, type StatusRole } from "@/lib/status-role";

export function pvcStatusOf(
  pvc: PersistentVolumeClaimInfo
): { text: string; role: StatusRole } | null {
  return pvc.status ? { text: pvc.status, role: statusRole(pvc.status) } : null;
}

export function pvcFactsSection(
  pvc: PersistentVolumeClaimInfo,
  t: T
): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "capacity"),
      values: [
        pvc.capacity
          ? { text: pvc.capacity, mono: true }
          : { text: t("empty", "notProvisionedYet"), role: "warn" },
      ],
    },
    {
      label: t("columns", "accessModes"),
      values: [
        {
          text: pvc.accessModes.length
            ? pvc.accessModes.join(" · ")
            : t("empty", "noneLower"),
          mono: true,
        },
      ],
    },
    {
      label: t("columns", "volume"),
      values: [
        pvc.volume
          ? {
              text: pvc.volume,
              ref: refOf({
                kind: "PersistentVolume",
                name: pvc.volume,
                namespace: null,
              }),
            }
          : { text: t("empty", "notBoundNothingSatisfied"), role: "warn" },
      ],
    },
    {
      label: t("columns", "storageClass"),
      values: [
        pvc.storageClass
          ? {
              text: pvc.storageClass,
              ref: refOf({
                kind: "StorageClass",
                name: pvc.storageClass,
                namespace: null,
              }),
            }
          : { text: t("empty", "clusterDefault") },
      ],
    },
  ];
  return {
    id: "pvc-facts",
    order: ORDER.own,
    title: t("columns", "claim"),
    icon: iconSvg(Database),
    body: { type: "facts", rows },
  };
}
