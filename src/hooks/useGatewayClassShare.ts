import { useCallback } from "react";

import type { ShareContribution } from "@/components/share/contribution";
import type { ReportStat } from "@/lib/report";
import { useT, type T } from "@/i18n/useT";
import type { GatewayClassInfo } from "@/generated/types";

export function gatewayClassStats(cls: GatewayClassInfo, t: T): ReportStat[] {
  return [
    { label: t("columns", "controller"), value: cls.controllerName },
    cls.accepted === true
      ? {
          label: t("columns", "claim"),
          value: t("empty", "claimedBy", { name: cls.controllerName }),
          role: "ok",
        }
      : cls.accepted === false
        ? {
            label: t("columns", "claim"),
            value: t("empty", "refusedBy", { name: cls.controllerName }),
            role: "err",
          }
        : {
            label: t("columns", "claim"),
            value: t("empty", "gwClassNoAnswer"),
            role: "warn",
          },
  ];
}

/**
 * What the GatewayClass page adds to Share: which controller claims it and
 * whether it accepted. Its conditions are the frame's own, `conditions` is
 * already top-level on this object, the shape the frame auto-detects.
 */
export function useGatewayClassShare(
  cls: GatewayClassInfo | undefined
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!cls) return {};
    return { stats: gatewayClassStats(cls, t) };
  }, [cls, t]);
}
