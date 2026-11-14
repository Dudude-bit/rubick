/** The words of a workload's Traffic block, for the block and its Share. */
import { ArrowRightLeft } from "lucide-react";

import type { WorkloadKey } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { formatShare } from "@/lib/cost";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import type { FlowRow, TrafficReading } from "@/lib/traffic";
import {
  bytesRate,
  endLabel,
  endSub,
  ms,
  rate,
} from "../../-traffic/traffic-words";

/** The API group of each kind this block is drawn for. */
const GROUP: Record<string, string> = {
  Deployment: "apps",
  StatefulSet: "apps",
  DaemonSet: "apps",
  Job: "batch",
  CronJob: "batch",
};

export function subjectOf(
  kind: string,
  namespace: string | null | undefined,
  name: string | null | undefined
): WorkloadKey | null {
  return namespace && name
    ? { namespace, group: GROUP[kind] ?? "", kind, name }
    : null;
}

/** A row's own rate, by the first family it has. */
function rateWords(row: FlowRow, t: T): string {
  if (row.requests.value !== null)
    return t("traffic", "subRequests", { v: rate(row.requests.value) });
  if (row.bytes.value !== null) return bytesRate(row.bytes.value);
  if (row.events.value !== null)
    return t("traffic", "subEvents", { v: rate(row.events.value) });
  return t("traffic", "cellNone");
}

export function rowWords(row: FlowRow, peer: "from" | "to", t: T): string[] {
  return [
    `${endLabel(row[peer])} (${endSub(row[peer], t)})`,
    rateWords(row, t),
    row.errorShare.value === null
      ? ""
      : t("traffic", "subErrors", { share: formatShare(row.errorShare.value) }),
    row.p95.value === null ? "" : `p95 ${ms(row.p95.value, t)}`,
    row.requests.source ?? row.bytes.source ?? row.events.source ?? "",
  ];
}

/** What each source can say about a workload with no flows, or about its reach. */
export function subjectNotes(
  reading: TrafficReading,
  quiet: boolean,
  window: string,
  t: T
): string[] {
  const out: string[] = [];
  reading.sources.forEach((source, index) => {
    const seen = reading.answer.observed?.find((each) => each.source === index);
    if (source.marks && seen && seen.pods > 0) {
      if (seen.marked === 0) {
        out.push(
          t("traffic", "notObserved", {
            source: source.name,
            pods: t("count", "itsPods", { n: seen.pods }),
          })
        );
        return;
      }
      if (seen.marked < seen.pods)
        out.push(
          t("traffic", "partlyObserved", {
            source: source.name,
            marked: seen.marked,
            pods: t("count", "itsPods", { n: seen.pods }),
          })
        );
    }
    if (quiet)
      out.push(
        t("traffic", source.nodeAgent ? "quietNodeAgent" : "quiet", {
          source: source.name,
          window,
        })
      );
  });
  if (reading.answer.podsFailed)
    out.push(
      t("traffic", "podsFailed", { said: reading.answer.podsFailed.message })
    );
  return out;
}

export function trafficSection(
  callers: readonly FlowRow[],
  callees: readonly FlowRow[],
  notes: readonly string[],
  t: T
): PlacedSection {
  const line = (row: FlowRow, peer: "from" | "to", way: string) => {
    const [name, ...rest] = rowWords(row, peer, t);
    return {
      cells: [
        { text: way },
        { text: name, mono: true },
        { text: rest.filter(Boolean).join(" · ") },
      ],
    };
  };
  return {
    id: "traffic",
    order: ORDER.traffic,
    title: t("traffic", "title"),
    icon: iconSvg(ArrowRightLeft),
    count: callers.length + callees.length,
    partial: notes.length > 0 ? notes.join(" ") : null,
    body: {
      type: "table",
      columns: [
        t("traffic", "shareWay"),
        t("traffic", "sharePeer"),
        t("traffic", "shareNumbers"),
      ],
      rows: [
        ...callers.map((row) => line(row, "from", t("traffic", "callers"))),
        ...callees.map((row) => line(row, "to", t("traffic", "callees"))),
      ],
      more: null,
    },
  };
}
