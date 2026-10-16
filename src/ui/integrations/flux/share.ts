import { Box } from "lucide-react";

import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { FluxControllers } from "./data";

/** Controllers short of replicas; a Deployment list refused or not yet read is unread, not ready. */
export function controllersSection(
  read: FluxControllers | undefined,
  t: T
): PlacedSection | null {
  const shell = {
    id: "flux-controllers",
    order: ORDER.own,
    title: t("empty", "fluxWorkloadsTitle"),
    icon: iconSvg(Box),
  };
  if (!read || read.unread)
    return {
      ...shell,
      count: null,
      unread: read?.unread
        ? sayWords(read.unread, t)
        : t("share", "stillReading"),
      body: { type: "findings", items: [] },
    };
  const found = read.controllers.flatMap((controller) =>
    controller.ready < controller.desired
      ? [
          {
            title: controller.name,
            detail: t("count", "ofTotalReady", {
              n: controller.ready,
              total: controller.desired,
            }),
            role: "err" as const,
            ref: refOf({
              kind: "Deployment",
              name: controller.name,
              namespace: controller.namespace,
            }),
          },
        ]
      : []
  );
  if (found.length === 0) return null;
  return {
    ...shell,
    count: found.length,
    body: { type: "findings", items: found },
  };
}
