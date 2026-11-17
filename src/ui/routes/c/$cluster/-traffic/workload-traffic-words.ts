/** The words of a workload's Traffic block, for the block and its Share. */
import { ArrowRightLeft } from "lucide-react";

import type { WorkloadKey } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import {
  heard,
  silenceOf,
  type FlowRow,
  type TrafficReading,
} from "@/lib/traffic";
import {
  bytesRate,
  cellText,
  endLabel,
  endSub,
  ms,
  rate,
} from "./traffic-words";

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

/**
 * The CronJob a Job's flows are filed under: its pods are keyed to it, and
 * Hubble strips the run's suffix too, so no flow ever names the Job.
 */
/** An owner reference, in either shape the app reads one. */
export interface Owned {
  kind: string;
  name: string;
  controller?: boolean | null;
}

export function cronJobOf(owners: readonly Owned[]): string | null {
  return (
    owners.find(
      (owner) => owner.controller === true && owner.kind === "CronJob"
    )?.name ?? null
  );
}

const RATES = ["requests", "bytes", "events"] as const;

/** A row with no rate, where one of its rates could not be read: not "none". */
export function rateUnread(row: FlowRow): boolean {
  return (
    RATES.every((family) => row[family].value === null) &&
    RATES.some((family) => row[family].state === "notRead")
  );
}

/** A row's own rate, by the first family it has. */
function rateWords(row: FlowRow, t: T): string {
  if (row.requests.value !== null)
    return t("traffic", "subRequests", { v: rate(row.requests.value) });
  if (row.bytes.value !== null) return bytesRate(row.bytes.value);
  if (row.events.value !== null)
    return t("traffic", "subEvents", { v: rate(row.events.value) });
  return t("traffic", rateUnread(row) ? "cellNotRead" : "cellNone");
}

export function rowWords(row: FlowRow, peer: "from" | "to", t: T): string[] {
  return [
    `${endLabel(row[peer])} (${endSub(row[peer], t)})`,
    rateWords(row, t),
    row.errorShare.value === null
      ? ""
      : t("traffic", "subErrors", {
          share: cellText(row.errorShare, "share", t),
        }),
    row.p95.value === null ? "" : `p95 ${ms(row.p95.value, t)}`,
    row.requests.source ?? row.bytes.source ?? row.events.source ?? "",
  ];
}

export interface BlockNote {
  text: string;
  /** `warn`: something was not looked at. */
  tone: "warn" | "mute";
}

/** What each source can say about its reach, and why it has no flow where it has none. */
export function subjectNotes(
  reading: TrafficReading,
  subject: WorkloadKey,
  window: string,
  t: T
): BlockNote[] {
  const out: BlockNote[] = [];
  const mute = (text: string) => out.push({ text, tone: "mute" });
  const warn = (text: string) => out.push({ text, tone: "warn" });
  reading.sources.forEach((source, index) => {
    const seen = reading.answer.observed?.find((each) => each.source === index);
    if (source.marks && seen && seen.pods > 0) {
      if (seen.marked === 0) {
        mute(
          t("traffic", "notObserved", {
            source: source.name,
            pods: t("count", "itsPods", { n: seen.pods }),
          })
        );
        return;
      }
      if (seen.marked < seen.pods)
        mute(
          t("traffic", "partlyObserved", {
            source: source.name,
            marked: seen.marked,
            pods: t("count", "itsPods", { n: seen.pods }),
          })
        );
    }
    const silence = silenceOf(reading, index, subject.namespace);
    if (heard(reading, index)) {
      if (silence.says === "notRead")
        warn(
          t("traffic", "sourcePartly", {
            source: source.name,
            said: silence.said,
          })
        );
      return;
    }
    switch (silence.says) {
      case "notRead":
        warn(
          t("traffic", "quietNotRead", {
            source: source.name,
            said: silence.said,
          })
        );
        return;
      case "unmatched":
        warn(
          t("traffic", "quietUnmatched", {
            source: source.name,
            namespace: subject.namespace,
          })
        );
        return;
      case "quiet":
        mute(
          t("traffic", source.nodeAgent ? "quietNodeAgent" : "quiet", {
            source: source.name,
            window,
          })
        );
    }
  });
  if (reading.answer.podsFailed)
    warn(
      t("traffic", "podsFailed", { said: reading.answer.podsFailed.message })
    );
  return out;
}

export function trafficSection(
  callers: readonly FlowRow[],
  callees: readonly FlowRow[],
  notes: readonly BlockNote[],
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
    partial: notes.length > 0 ? notes.map((note) => note.text).join(" ") : null,
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
