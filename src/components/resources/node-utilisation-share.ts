import { Gauge } from "lucide-react";

import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { ResourceType } from "@/lib/resource-registry";
import type { T } from "@/i18n/useT";
import type { NodeTrend, TrendBlind } from "@/lib/node-trends";
import type { en } from "@/i18n/catalogue";

const BLIND_SHORT: Record<TrendBlind, keyof typeof en.empty> = {
  notLooked: "notLookedShort",
  noSeries: "noSeriesShort",
  noAllocatable: "noAllocatableShort",
};

function laneValue(
  lane: NodeTrend["cpu"],
  blind: TrendBlind | null,
  t: T
): ReportValue {
  if (lane === null)
    return {
      text: t("empty", BLIND_SHORT[blind ?? "noSeries"]),
      quiet: true,
    };
  return {
    text: t("readings", "peakAvgPercent", {
      peak: Math.round(lane.peak),
      avg: Math.round(lane.avg),
    }),
  };
}

export interface UtilisationShareInput {
  trends: readonly NodeTrend[];
  notes: readonly (string | null)[];
  fromPods: boolean;
  silent: boolean;
  vendor: string | null;
  /** False when no usage vendor is connected: there is no table to draw,
   *  only the same word the view itself says instead of one. */
  capable: boolean;
  /**
   * A read that failed or was never possible, the node list refused, the
   * vendor unreachable, the window's own read failed. The table's `unread`
   * carries it instead of drawing an empty table in its place.
   */
  unread: string | null;
}

/**
 * What the Utilisation view draws: one table row per node, least headroom
 * first, plus the two lines that keep a quiet table from being read as a
 * quiet cluster, the pods-summed basis, and every node having no series.
 */
export function nodeUtilisationSections(
  input: UtilisationShareInput,
  t: T
): PlacedSection[] {
  const { trends, notes, fromPods, silent, vendor, capable, unread } = input;
  if (!capable)
    return [
      {
        id: "utilisation",
        order: ORDER.own,
        title: t("columns", "utilisation"),
        icon: iconSvg(Gauge),
        body: { type: "text", text: t("empty", "trendsNeedPrometheus") },
      },
    ];
  const table: PlacedSection = {
    id: "utilisation",
    order: ORDER.own,
    title: t("columns", "utilisation"),
    icon: iconSvg(Gauge),
    count: trends.length,
    unread,
    body: {
      type: "table",
      columns: [
        t("columns", "node"),
        t("columns", "cpuOfAllocatable"),
        t("columns", "memoryOfAllocatable"),
        t("columns", "note"),
      ],
      rows: trends.map((trend, index) => ({
        cells: [
          {
            text: trend.node.name,
            ref: refOf({
              kind: ResourceType.Node,
              name: trend.node.name,
              namespace: null,
            }),
          },
          laneValue(trend.cpu, trend.blind, t),
          laneValue(trend.memory, trend.blind, t),
          { text: notes[index] ?? "–", quiet: true },
        ],
      })),
      more: null,
    },
  };
  const sections = [table];
  if (fromPods && vendor)
    sections.push({
      id: "utilisation-basis",
      order: ORDER.own,
      title: t("share", "scrBasis"),
      icon: iconSvg(Gauge),
      body: { type: "text", text: t("empty", "nodesFromPods", { vendor }) },
    });
  if (silent && vendor)
    sections.push({
      id: "utilisation-silence",
      order: ORDER.own,
      title: t("share", "scrSilent"),
      icon: iconSvg(Gauge),
      body: {
        type: "text",
        text: `${t("empty", "nodesSilentTitle", { vendor })} ${t("empty", "nodesSilentReason", { vendor })}`,
        role: "warn",
      },
    });
  return sections;
}
