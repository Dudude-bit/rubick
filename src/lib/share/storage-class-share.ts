import { HardDrive } from "lucide-react";

import type { StorageClassInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, type PlacedSection } from "@/lib/report-parts";

export function storageClassFactsSection(
  sc: StorageClassInfo,
  t: T
): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "provisioner"),
      values: [{ text: sc.provisioner, mono: true }],
    },
    {
      label: t("columns", "reclaimPolicy"),
      values: [{ text: sc.reclaimPolicy, mono: true }],
    },
    {
      label: t("columns", "bindingMode"),
      values: [{ text: sc.volumeBindingMode, mono: true }],
    },
    {
      label: t("columns", "defaultClass"),
      values: [
        {
          text: sc.isDefault
            ? t("empty", "claimsUseThisClass")
            : t("empty", "noLower"),
        },
      ],
    },
  ];
  return {
    id: "storage-class-facts",
    order: ORDER.own,
    title: t("columns", "storageClass"),
    icon: iconSvg(HardDrive),
    body: { type: "facts", rows },
  };
}
