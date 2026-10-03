import { Lock } from "lucide-react";

import type { SecretInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import type { StatusRole } from "@/lib/status-role";

export function secretTypeOf(secret: SecretInfo): {
  text: string;
  role: StatusRole;
} {
  return { text: secret.type.replace("kubernetes.io/", ""), role: "neutral" };
}

/**
 * Key names only, never a value: a Secret's whole reason to exist is that its
 * values must not travel, and a byte count is still a hint a value beyond a
 * count is exactly what the caller asked this section not to give.
 */
export function secretKeysSection(dataKeys: string[], t: T): PlacedSection {
  return {
    id: "secret-keys",
    order: ORDER.own,
    title: t("share", "clSectionKeys"),
    icon: iconSvg(Lock),
    count: dataKeys.length,
    body: {
      type: "table",
      columns: [t("share", "clKeyColumn")],
      rows: dataKeys.map((key) => ({ cells: [{ text: key, mono: true }] })),
      more: null,
    },
  };
}
