import { Database } from "lucide-react";

import type { PersistentVolumeClaimInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { causeRole, claimRole, type ClaimCause } from "@/lib/claim-cause";
import { iconSvg } from "@/lib/icon-svg";
import { declaredQuantity } from "@/lib/metric-format";
import type { ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { StatusRole } from "@/lib/status-role";

export function pvcStatusOf(
  pvc: PersistentVolumeClaimInfo,
  cause: ClaimCause | null,
  now: number
): { text: string; role: StatusRole } | null {
  return pvc.status
    ? { text: pvc.status, role: claimRole(pvc, cause, now) }
    : null;
}

/** The volume row of a claim with none bound: a wait by design said as one, not as a fault. */
function unboundValue(
  pvc: PersistentVolumeClaimInfo,
  cause: ClaimCause | null,
  now: number,
  t: T
): ReportValue {
  return cause && causeRole(pvc, cause, now) === "pending"
    ? { text: t("empty", "notBoundYet"), role: "pending" }
    : { text: t("empty", "notBoundNothingSatisfied"), role: "warn" };
}

export function pvcFactsSection(
  pvc: PersistentVolumeClaimInfo,
  t: T,
  cause: ClaimCause | null,
  now: number
): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "capacity"),
      values: [
        pvc.capacity
          ? { text: declaredQuantity("storage", pvc.capacity), mono: true }
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
        cause?.says === "volumeMissing"
          ? {
              text: t("readings", "envObjectNotThere", {
                object: cause.volume,
              }),
              role: "err",
            }
          : pvc.volume
            ? {
                text: pvc.volume,
                ref: refOf({
                  kind: "PersistentVolume",
                  name: pvc.volume,
                  namespace: null,
                }),
              }
            : unboundValue(pvc, cause, now, t),
      ],
    },
    {
      label: t("columns", "storageClass"),
      values: [
        cause?.says === "classMissing"
          ? {
              text: t("readings", "envObjectNotThere", { object: cause.name }),
              role: "err",
            }
          : pvc.storageClass
            ? {
                text: pvc.storageClass,
                ref: refOf({
                  kind: "StorageClass",
                  name: pvc.storageClass,
                  namespace: null,
                }),
              }
            : {
                text: t(
                  "empty",
                  pvc.storageClass === ""
                    ? "noClassOnPurpose"
                    : "clusterDefault"
                ),
              },
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
