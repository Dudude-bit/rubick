import { Waypoints } from "lucide-react";

import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import type { MapTone } from "@/integrations";
import type { StatusRole } from "@/lib/status-role";
import type { Model } from "./model";

const TONE_ROLE: Record<MapTone, StatusRole | undefined> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  mute: undefined,
  unknown: undefined,
};

/**
 * The map as one table: a row a group, what it holds and what was not read
 * in it. Every kind the map could not read is named above it, so the file
 * never reads as a cluster with fewer objects than it has.
 */
export function topologySection(
  model: Model,
  notRead: readonly string[],
  t: T,
  caption: string
): PlacedSection {
  return {
    id: "topology",
    order: ORDER.own,
    title: t("topology", "title"),
    icon: iconSvg(Waypoints),
    count: model.groups.length,
    partial:
      notRead.length > 0
        ? t("topology", "shareNotRead", { kinds: notRead.join(", ") })
        : null,
    caption,
    body: {
      type: "table",
      columns: [t("topology", "shareGroup"), t("topology", "shareHolds")],
      rows: model.groups.map((group) => ({
        cells: [
          { text: group.label, mono: true },
          {
            text: model.summaries.get(group.id) ?? "",
            role: TONE_ROLE[group.tone],
            unread: group.tone === "unknown",
          },
        ],
      })),
      more: null,
    },
  };
}
