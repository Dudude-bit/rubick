import { HardDrive } from "lucide-react";

import type { CustomResourceInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { Read } from "./data";
import { readNodeConfig } from "./model";

/** NodeConfigs with a problem; a list refused or not yet read is unread, not clean. */
export function nodeConfigsSection(
  read: Read<CustomResourceInfo> | undefined,
  t: T
): PlacedSection | null {
  const shell = {
    id: "scylla-node-configs",
    order: ORDER.own,
    title: t("operators", "nodeConfigsTab"),
    icon: iconSvg(HardDrive),
  };
  const unread = (why: string): PlacedSection => ({
    ...shell,
    count: null,
    unread: why,
    body: { type: "findings", items: [] },
  });
  if (!read) return unread(t("share", "stillReading"));
  if (!read.ok) return unread(read.reason);
  const found = read.items.flatMap((resource) => {
    const setup = readNodeConfig(resource);
    if (setup.problems.length === 0 && setup.unsure.length === 0) return [];
    const first = setup.problems[0];
    return [
      {
        title: setup.name,
        detail: first ? (first.message ?? first.type) : setup.unsure.join(", "),
        role: "warn" as const,
        ref: refOf({
          kind: "NodeConfig",
          name: setup.name,
          namespace: resource.namespace ?? null,
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
