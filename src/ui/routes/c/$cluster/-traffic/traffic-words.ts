/**
 * The words for flows: an end, a cell, a source's own line. Every map from
 * a state to words is a `Record` the compiler holds total.
 */
import type {
  Coverage,
  FlowEnd,
  Measure,
  PolicyRef,
  WorkloadKey,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import { formatShare } from "@/lib/cost";
import { formatQuantity } from "@/lib/metric-format";
import type {
  Cell,
  CellState,
  FlowRow,
  FlowSourceState,
  FlowWindow,
  SourceLine,
  TrafficReading,
  TrafficWord,
} from "@/lib/traffic";
import type { MapTone } from "@/integrations";
import type { Known } from "@/lib/known";
import { lineShare, MEASURES, shareTone, silenceOf } from "@/lib/traffic";
import type { PolicyReading } from "./policy-reading";
import { formatRate } from "@/lib/utils";

export const WINDOW_WORD = {
  "5m": "window5m",
  "15m": "window15m",
  "1h": "window1h",
} as const satisfies Record<FlowWindow, TrafficWord>;

export const MEASURE_WORD = {
  requests: "measureRequests",
  errors: "measureErrors",
  p50: "measureP50",
  p95: "measureP95",
  p99: "measureP99",
  bytes: "measureBytes",
  events: "measureEvents",
  drops: "measureDrops",
} as const satisfies Record<Measure, TrafficWord>;

export const SOURCE_STATE_WORD = {
  present: "railPresent",
  absent: "railAbsent",
  unpaired: "railUnpaired",
  failed: "railFailed",
  connecting: "railConnecting",
  off: "railOff",
  stopped: "railStopped",
} as const satisfies Record<FlowSourceState["says"], TrafficWord>;

/** An end's name, as the source or the cluster wrote it. */
export function endLabel(end: FlowEnd): string {
  switch (end.is) {
    case "workload":
      return end.key.name;
    case "ambiguous":
    case "notListed":
    case "service":
    case "node":
    case "remote":
      return end.name;
    case "address":
      return end.address;
    case "unidentified":
      return end.word || "?";
  }
}

/** What an end is, under its name. */
export function endSub(end: FlowEnd, t: T): string {
  switch (end.is) {
    case "workload":
      return end.key.namespace;
    case "ambiguous":
      return t("traffic", "endAmbiguous", { kinds: end.kinds.join(", ") });
    case "notListed":
      return end.why === "podsUnread"
        ? t("traffic", "endPodsUnread", { namespace: end.namespace })
        : t("traffic", "endNotListed", { namespace: end.namespace });
    case "service":
      return end.namespace
        ? t("traffic", "endService", { namespace: end.namespace })
        : t("traffic", "endServiceNowhere");
    case "node":
      return t("traffic", "endNode");
    case "address":
      return t("traffic", "endAddress");
    case "unidentified":
      return t("traffic", "endUnidentified");
    case "remote":
      return t("traffic", "endRemote", {
        namespace: end.namespace,
        cluster: end.cluster,
      });
  }
}

/** How much of the workloads here a source's mesh holds, each part said only where it is not zero. */
export function coverageWords(
  coverage: Coverage,
  source: string,
  t: T
): string {
  const none = coverage.workloads - coverage.marked - coverage.partly;
  const parts = (
    [
      ["coverageWhole", coverage.marked],
      ["coveragePartly", coverage.partly],
      ["coverageNone", none],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([key, n]) => t("traffic", key, { n }));
  return t("traffic", "coverage", {
    source,
    of: t("count", "ofWorkloads", { n: coverage.workloads }),
    parts: parts.join(", "),
  });
}

/** What an end's cell says on its one line, for the width it takes. */
export function endText(end: FlowEnd, t: T): string {
  switch (end.is) {
    case "workload":
      return `${end.key.namespace}/${end.key.name}`;
    case "service":
      return `${end.namespace ? `${end.namespace}/` : ""}${end.name} Service`;
    default:
      return `${endLabel(end)} ${endSub(end, t)}`;
  }
}

/** The kind an end is drawn as. */
export function endKind(end: FlowEnd): string {
  switch (end.is) {
    case "workload":
      return end.key.kind;
    case "notListed":
      return end.kind ?? "Workload";
    case "service":
      return "Service";
    case "node":
      return "Node";
    case "remote":
      return end.kind;
    case "ambiguous":
    case "address":
    case "unidentified":
      return "";
  }
}

export const rate = (value: number) => formatRate(value);
export const bytesRate = (value: number) => formatQuantity(value, "throughput");
export const ms = (value: number, t: T) =>
  t("traffic", "milliseconds", { v: rate(value) });

export type CellKind = "rate" | "bytes" | "share" | "ms";

/** A cell's text: its number, or why there is none. */
export function cellText(cell: Cell, kind: CellKind, t: T): string {
  if (cell.value === null) return CELL_EMPTY[cell.state](t);
  switch (kind) {
    case "rate":
      return rate(cell.value);
    case "bytes":
      return bytesRate(cell.value);
    case "share":
      // "At least" rounds down: a floor of 12.6% is not "≥13%".
      return cell.floor
        ? `≥${formatShare(cell.value, "down")}`
        : formatShare(cell.value);
    case "ms":
      return ms(cell.value, t);
  }
}

const CELL_EMPTY: Record<CellState, (t: T) => string> = {
  measured: (t) => t("traffic", "cellNone"),
  notMeasured: () => "",
  belowHttp: () => "",
  notRead: (t) => t("traffic", "cellNotRead"),
};

/** Where a cell's number came from, or why it has none, for its title. */
export function cellTitle(cell: Cell, row: FlowRow, t: T): string {
  switch (cell.state) {
    case "measured":
      if (cell.floor)
        return t("traffic", "cellFloor", { source: cell.source ?? "" });
      return cell.source
        ? t("traffic", "cellFrom", { source: cell.source })
        : "";
    case "notMeasured":
      return t("traffic", "cellNotMeasured", {
        sources: row.seenBy.join(", "),
      });
    case "notRead":
      return t("traffic", "cellNotReadBy", { source: cell.source ?? "" });
    case "belowHttp":
      return t("traffic", "cellBelowHttp", { sources: row.seenBy.join(", ") });
  }
}

const at = (measure: Measure) => MEASURES.indexOf(measure);

/** A line of a source's numbers; `tone` where it is a share of errors. */
export interface PanelLine {
  text: string;
  tone: MapTone | null;
}

/** One source's own numbers on a pair, each said as what it counted. */
export function sourceLines(line: SourceLine, t: T): PanelLine[] {
  const value = (measure: Measure) => line.values[at(measure)] ?? null;
  const out: PanelLine[] = [];
  const say = (text: string) => out.push({ text, tone: null });
  const requests = value("requests");
  if (requests !== null) {
    say(t("traffic", "panelRequests", { v: rate(requests) }));
    const share = lineShare(line);
    if (share.value !== null)
      out.push({
        text: t(
          "traffic",
          line.source.grpcErrors ? "panelErrors" : "panelErrorsHttp",
          { share: formatShare(share.value) }
        ),
        tone: shareTone(share),
      });
  }
  const quantiles = (["p50", "p95", "p99"] as const)
    .map((measure) => {
      const v = value(measure);
      return v === null ? null : `${measure} ${ms(v, t)}`;
    })
    .filter((part): part is string => part !== null);
  if (quantiles.length > 0) say(quantiles.join(" · "));
  const bytes = value("bytes");
  if (bytes !== null) say(t("traffic", "panelBytes", { v: bytesRate(bytes) }));
  const events = value("events");
  // "0 forwarded" beside the drops reads as a contradiction; the zero says nothing.
  if (events !== null && events > 0)
    say(t("traffic", "panelEvents", { v: rate(events) }));
  const drops = value("drops");
  if (drops !== null) say(t("traffic", "panelDrops", { v: rate(drops) }));
  // A pair is below HTTP only where its source read HTTP and had none of it.
  if (requests === null && line.source.measures.includes("requests"))
    say(
      t(
        "traffic",
        line.unread.includes("requests")
          ? "panelRequestsUnread"
          : "panelBelowHttp"
      )
    );
  if (line.protocols.length > 0)
    say(t("traffic", "panelProtocols", { list: line.protocols.join(", ") }));
  return out;
}

/** Which proxy of the pair a source's numbers came from; nothing where it has one. */
export function sideWords(line: SourceLine, t: T): string | null {
  const server = line.sides.includes("server");
  const caller = line.sides.includes("caller");
  if (server && caller) return t("traffic", "panelSideBoth");
  if (server) return t("traffic", "panelSideServer");
  if (caller) return t("traffic", "panelSideCaller");
  return null;
}

/** The edge's second line: the row's own numbers, and whose they are. */
export function edgeSub(row: FlowRow, t: T): string {
  const parts: string[] = [];
  if (row.requests.value !== null)
    parts.push(t("traffic", "subRequests", { v: rate(row.requests.value) }));
  else if (row.bytes.value !== null) parts.push(bytesRate(row.bytes.value));
  else if (row.events.value !== null)
    parts.push(t("traffic", "subEvents", { v: rate(row.events.value) }));
  if (row.errorShare.value !== null)
    parts.push(
      t("traffic", "subErrors", {
        share: cellText(row.errorShare, "share", t),
      })
    );
  if (row.p95.value !== null) parts.push(`p95 ${ms(row.p95.value, t)}`);
  if ((row.drops.value ?? 0) > 0)
    parts.push(t("traffic", "subDrops", { v: rate(row.drops.value ?? 0) }));
  const source =
    row.requests.source ?? row.bytes.source ?? row.events.source ?? null;
  if (source) parts.push(source);
  return parts.join(" · ");
}

/** The policies that denied a drop, as the source named them. */
export const policyWords = (policies: readonly PolicyRef[]) =>
  policies
    .map((p) => `${p.kind} ${p.namespace ? `${p.namespace}/` : ""}${p.name}`)
    .join(", ");

/** Each source's failed reads, whole or in part, as lines above the map. */
export function unreadNotes(reading: TrafficReading, t: T): string[] {
  return reading.sources.flatMap((source, index) => {
    const silence = silenceOf(reading, index, null);
    return silence.says === "notRead"
      ? [
          t("traffic", silence.all ? "sourceUnread" : "sourcePartly", {
            source: source.name,
            said: silence.said,
          }),
        ]
      : [];
  });
}

/** What a reading with no flow says: who saw none, and who could not be read. */
export function nothingWords(
  reading: TrafficReading,
  scope: string,
  window: string,
  t: T
): string {
  const quiet: string[] = [];
  const unread: string[] = [];
  reading.sources.forEach((source, index) =>
    (silenceOf(reading, index, null).says === "notRead" ? unread : quiet).push(
      source.name
    )
  );
  return [
    quiet.length > 0
      ? t("traffic", "nothingInWindow", {
          sources: quiet.join(", "),
          scope,
          window,
        })
      : "",
    unread.length > 0
      ? t("traffic", "notReadInWindow", { sources: unread.join(", ") })
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

const policyNames = (namespace: string, names: readonly string[]) =>
  names.map((name) => `NetworkPolicy ${namespace}/${name}`).join(", ");

/** The app's reading of the policies on a drop Hubble named none for, said as the app's. */
/** One sentence of the reading, with whether it says what is, or that it could not be read. */
export interface ReadingPart {
  text: string;
  known: boolean;
}

export function readingWords(
  reading: PolicyReading,
  others: Known<string[]>,
  from: WorkloadKey,
  to: WorkloadKey,
  t: T
): ReadingPart[] {
  const out: ReadingPart[] = [];
  const say = (text: string, known = true) => out.push({ text, known });
  say(t("traffic", "readingByApp"));
  switch (reading.says) {
    case "noRuleAdmits": {
      const ingress = reading.direction === "ingress";
      const held = ingress ? to : from;
      say(
        t("traffic", ingress ? "readingNoIngress" : "readingNoEgress", {
          n: reading.policies.length,
          held: held.name,
          other: (ingress ? from : to).name,
          policies: policyNames(held.namespace, reading.policies),
        })
      );
      break;
    }
    case "unsettled": {
      const held = reading.direction === "ingress" ? to : from;
      say(
        t("traffic", "readingUnsettled", {
          held: held.name,
          other: (reading.direction === "ingress" ? from : to).name,
          policies: policyNames(held.namespace, reading.policies),
        })
      );
      break;
    }
    case "notSelected":
      say(t("traffic", "readingNotSelected", { to: to.name, from: from.name }));
      break;
    case "unread":
      say(
        reading.why === null
          ? t("traffic", "readingUnreadBare")
          : t("traffic", "readingUnread", { why: reading.why }),
        false
      );
  }
  if (!others.known)
    say(t("traffic", "readingOthersUnread", { why: others.why ?? "" }), false);
  else if (others.value.length > 0)
    say(t("traffic", "readingOthers", { kinds: others.value.join(", ") }));
  return out;
}
