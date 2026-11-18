import { Waypoints } from "lucide-react";

import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import type { MapTone } from "@/integrations";
import type { StatusRole } from "@/lib/status-role";
import { mapStopped, type TopologySnapshot } from "../-map/useTopology";
import type { Model } from "./model";

const TONE_ROLE: Record<MapTone, StatusRole | undefined> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  mute: undefined,
  unknown: undefined,
};

/**
 * How much of the map a share holds: a map that stopped or is still opening
 * is unread, and one still being drawn is the groups read so far.
 */
export function shareSaid(
  map: Pick<TopologySnapshot, "phase" | "error" | "end">,
  caveats: readonly string[],
  t: T
): { unread: string | null; notes: readonly string[] } {
  const stopped = mapStopped(map, t);
  if (stopped !== null) return { unread: stopped, notes: caveats };
  if (map.phase === "opening")
    return { unread: t("topology", "shareStillOpening"), notes: caveats };
  if (map.phase === "drawing")
    return {
      unread: null,
      notes: [t("topology", "shareStillDrawing"), ...caveats],
    };
  return { unread: null, notes: caveats };
}

/**
 * The map as one table: a row a group, what it holds and what was not read
 * in it. What the screen says above the map goes above the table, and a map
 * not drawn yet, or never opened, is said to be unread rather than handed
 * over as a cluster holding nothing.
 */
export function topologySection(
  model: Model,
  said: {
    /** Why nothing of the map can be read: it failed, or is still opening. */
    unread: string | null;
    /** Every line the screen draws above the map about what it could not read. */
    notes: readonly string[];
  },
  t: T,
  caption: string
): PlacedSection {
  return {
    id: "topology",
    order: ORDER.own,
    title: t("topology", "title"),
    icon: iconSvg(Waypoints),
    count: said.unread === null ? model.groups.length : null,
    unread: said.unread,
    partial: said.notes.length > 0 ? said.notes.join(" · ") : null,
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
