import { Archive } from "lucide-react";

import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { getValueByPath } from "../kit";
import type { Companions } from "./data";

/** Failed backups; a Backup list refused or not yet read is unread, not clean. */
export function backupsSection(
  companions: Companions | undefined,
  t: T
): PlacedSection | null {
  const shell = {
    id: "cloudnativepg-backups",
    order: ORDER.own,
    title: t("operators", "backupsTab"),
    icon: iconSvg(Archive),
  };
  const unread = (why: string): PlacedSection => ({
    ...shell,
    count: null,
    unread: why,
    body: { type: "findings", items: [] },
  });
  if (!companions) return unread(t("share", "stillReading"));
  if (!companions.backups.ok) return unread(companions.backups.reason);
  const found = companions.backups.items.flatMap((backup) => {
    const phase = String(getValueByPath(backup, "status.phase") ?? "");
    if (phase !== "failed") return [];
    const error = getValueByPath(backup, "status.error");
    return [
      {
        title: backup.name,
        detail: typeof error === "string" && error ? error : phase,
        role: "err" as const,
        ref: refOf({
          kind: "Backup",
          name: backup.name,
          namespace: backup.namespace ?? null,
        }),
      },
    ];
  });
  if (found.length === 0) return null;
  return {
    ...shell,
    count: found.length,
    body: { type: "findings", items: found },
  };
}
