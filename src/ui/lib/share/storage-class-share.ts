import { HardDrive } from "lucide-react";

import type { StorageClassInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, type PlacedSection } from "@/lib/report-parts";

/** What a StorageClass says about itself, in the words its page, peek and Share all draw. */
export function storageClassFacts(sc: StorageClassInfo, t: T): ReportFact[] {
  return [
    { label: t("columns", "provisioner"), text: sc.provisioner, mono: true },
    {
      label: t("columns", "defaultClass"),
      // The one question people open this page to answer: does a claim that
      // names no class land here?
      text: sc.isDefault
        ? t("empty", "claimsUseThisClass")
        : t("empty", "noLower"),
    },
    {
      label: t("columns", "reclaimPolicy"),
      text: sc.reclaimPolicy,
      mono: true,
    },
    {
      label: t("columns", "bindingMode"),
      text: sc.volumeBindingMode,
      mono: true,
    },
    {
      label: t("columns", "volumeExpansion"),
      text: sc.allowVolumeExpansion
        ? t("empty", "expansionAllowed")
        : t("empty", "expansionNotAllowed"),
    },
  ];
}

interface ReportFact {
  label: string;
  text: string;
  mono?: boolean;
}

export function storageClassFactsSection(
  sc: StorageClassInfo,
  t: T
): PlacedSection {
  return {
    id: "storage-class-facts",
    order: ORDER.own,
    title: t("columns", "storageClass"),
    icon: iconSvg(HardDrive),
    body: {
      type: "facts",
      rows: storageClassFacts(sc, t).map(({ label, text, mono }) => ({
        label,
        values: [{ text, mono }],
      })),
    },
  };
}
