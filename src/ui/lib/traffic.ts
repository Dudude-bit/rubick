/**
 * Flows between workloads as the reader is shown them: one row a pair, each
 * number from one source and saying which, never two sources added.
 *
 * Pure: the page, the workload block and Share all read rows made here.
 */

import type {
  Flow,
  FlowEnd,
  LiveDrop,
  LiveEnd,
  LiveKey,
  LivePair,
  Measure,
  PolicyRef,
  RelayAt,
  TrafficAnswer,
  UnreachedNode,
  WorkloadKey,
} from "@/generated/types";
import type { en } from "@/i18n/catalogue";
import type { MapTone } from "@/integrations";

/** As `src/contracts/traffic-budget.json` states it; a test on each side holds them equal. */
export const MAX_FLOW_ROWS = 1000;

/** The order a flow's `values` are in, as the same file lists it. */
export const MEASURES = [
  "requests",
  "errors",
  "p50",
  "p95",
  "p99",
  "bytes",
  "events",
  "drops",
] as const satisfies readonly Measure[];

export const FLOW_WINDOWS = ["5m", "15m", "1h"] as const;
export type FlowWindow = (typeof FLOW_WINDOWS)[number];

/** A window the address names, or the shortest. */
export const windowOf = (value: string | undefined): FlowWindow =>
  FLOW_WINDOWS.find((each) => each === value) ?? "5m";

export type TrafficWord = keyof (typeof en)["traffic"];

export type FlowSourceState =
  | { says: "present" }
  | { says: "absent" }
  /** Its series are here and name no source or destination. */
  | { says: "unpaired" }
  | { says: "failed"; said: string }
  /** A live source still connecting, not enabled, or stopped: not found. */
  | { says: "connecting" }
  | { says: "off" }
  | { says: "stopped" };

/** A source of flows, as the supplier found it. */
export interface FlowSource {
  /** The supplier's own; a surface prints `name` and never branches on this. */
  id: string;
  name: string;
  state: FlowSourceState;
  /** What it can measure: a column it leaves empty says so, never 0. */
  measures: readonly Measure[];
  /** The metric names it found, for the rail, each with the end label it is read by (`{source_pod}`) where that differs by metric. */
  found: readonly string[];
  /** What it needs to have series here. */
  need: TrafficWord;
  /** It sees only pods it marks, and the answer says how many it marks. */
  marks: boolean;
  /** It sees only the nodes its agent runs on, which nothing here can tell. */
  nodeAgent: boolean;
  /** Some ends it writes are names only the pods resolve: unread pods hide its flows. */
  needsPods: boolean;
  /** Its errors include a failed gRPC call; else HTTP 5xx only. */
  grpcErrors: boolean;
}

/** One read: the present sources, positionally as each flow's `source`. */
export interface TrafficReading {
  sources: readonly FlowSource[];
  answer: TrafficAnswer;
  window: FlowWindow;
}

/** `belowHttp`: the source measures it, and saw this pair only beneath HTTP. */
export type CellState = "measured" | "notMeasured" | "notRead" | "belowHttp";

/** The measures a source has for a pair only where it reads its HTTP. */
const HTTP: ReadonlySet<Measure> = new Set([
  "requests",
  "errors",
  "p50",
  "p95",
  "p99",
]);

/** One number on a row, the source it came from, or why there is none. */
export interface Cell {
  value: number | null;
  source: string | null;
  state: CellState;
  /** A share of errors that is only a floor: its source cannot see a failed gRPC call. */
  floor?: true;
}

/**
 * gRPC answers a failed call with HTTP 200 and the status in a trailer, so
 * a source counting HTTP 5xx misses it on anything but HTTP/1.
 */
export const mayCarryGrpc = (protocols: readonly string[]) =>
  !(protocols.length > 0 && protocols.every((p) => p.startsWith("HTTP/1")));

/** Why flows were dropped, and the policies that denied them where the source says. */
export interface Reason {
  reason: string;
  rate: number;
  policies?: readonly PolicyRef[];
  /** An L7 rule denied the request at the proxy; `reason` is then Hubble's "unknown". */
  l7?: boolean;
}

/** One source's own numbers on a pair, for the panel. */
export interface SourceLine {
  source: FlowSource;
  values: readonly (number | null)[];
  reasons: readonly Reason[];
  protocols: readonly string[];
  /** The proxies of the pair its numbers came from: `server`, `caller`. */
  sides: readonly string[];
}

export interface FlowRow {
  id: string;
  fromId: string;
  toId: string;
  from: FlowEnd;
  to: FlowEnd;
  requests: Cell;
  /** Errors over requests, from the source the requests came from. */
  errorShare: Cell;
  p50: Cell;
  p95: Cell;
  p99: Cell;
  bytes: Cell;
  events: Cell;
  drops: Cell;
  reasons: readonly Reason[];
  seenBy: readonly string[];
  by: readonly SourceLine[];
}

const at = (measure: Measure) => MEASURES.indexOf(measure);

/** An end's identity: a workload by the topology's own id spelling, the rest by what they are. */
export function endId(end: FlowEnd): string {
  switch (end.is) {
    case "workload":
      return `${end.key.group}/${end.key.kind}/${end.key.namespace}/${end.key.name}`;
    case "ambiguous":
      return `ambiguous:${end.namespace}/${end.name}`;
    case "notListed":
      return `notListed:${end.namespace}/${end.kind ?? ""}/${end.name}`;
    case "service":
      return `service:${end.namespace ?? ""}/${end.name}`;
    case "node":
      return `node:${end.name}`;
    case "address":
      return `address:${end.address}`;
    case "unidentified":
      return `unidentified:${end.namespace ?? ""}/${end.word}`;
    case "remote":
      return `remote:${end.cluster}/${end.kind}/${end.namespace}/${end.name}`;
  }
}

export function isEnd(end: FlowEnd, key: WorkloadKey): boolean {
  return (
    end.is === "workload" &&
    end.key.namespace === key.namespace &&
    end.key.group === key.group &&
    end.key.kind === key.kind &&
    end.key.name === key.name
  );
}

function readsOf(reading: TrafficReading) {
  const failed = new Set<string>();
  for (const read of reading.answer.reads)
    if (read.state.says === "failed")
      failed.add(`${read.source}:${read.measure}`);
  return {
    failed: (source: number, measure: Measure) =>
      failed.has(`${source}:${measure}`),
    // A cell can turn "not read", or a source measure more, with its
    // pair's flows unchanged: a row reads the sources whole.
    key: JSON.stringify([reading.sources, [...failed]]),
  };
}

/**
 * A cell from the first source, in the reading's order, that has the number;
 * where none has it, "not read" if any source that measures it failed to
 * read it, "not measured" if none of the pair's sources measures it at all,
 * "below HTTP" where those that measure it have no requests for the pair.
 */
function cellOf(
  flows: readonly Flow[],
  reading: TrafficReading,
  failed: (source: number, measure: Measure) => boolean,
  measure: Measure
): { cell: Cell; flow: Flow | null } {
  for (const flow of flows) {
    const value = flow.values[at(measure)];
    if (value !== null && value !== undefined)
      return {
        cell: {
          value,
          source: reading.sources[flow.source]?.name ?? null,
          state: "measured",
        },
        flow,
      };
  }
  const measuring = flows.filter((flow) =>
    reading.sources[flow.source]?.measures.includes(measure)
  );
  // A failed query leaves its source no flow on any pair to be found by.
  const unread = reading.sources.findIndex(
    (source, index) =>
      source.measures.includes(measure) && failed(index, measure)
  );
  const belowHttp =
    HTTP.has(measure) &&
    measuring.every((flow) => flow.values[at("requests")] == null);
  return {
    cell: {
      value: null,
      source: unread >= 0 ? (reading.sources[unread]?.name ?? null) : null,
      state:
        unread >= 0
          ? "notRead"
          : measuring.length === 0
            ? "notMeasured"
            : belowHttp
              ? "belowHttp"
              : "measured",
    },
    flow: null,
  };
}

function errorShareOf(
  requests: { cell: Cell; flow: Flow | null },
  reading: TrafficReading,
  failed: (source: number, measure: Measure) => boolean
): Cell {
  const flow = requests.flow;
  if (!flow) return { ...requests.cell, value: null };
  const from = reading.sources[flow.source];
  const source = from?.name ?? null;
  if (failed(flow.source, "errors"))
    return { value: null, source, state: "notRead" };
  const errors = flow.values[at("errors")];
  const total = requests.cell.value ?? 0;
  const value =
    errors === null || errors === undefined || total <= 0
      ? null
      : errors / total;
  return {
    value,
    source,
    state: "measured",
    ...(value !== null && !from?.grpcErrors && mayCarryGrpc(flow.protocols)
      ? { floor: true as const }
      : {}),
  };
}

const signature = (flows: readonly Flow[]) =>
  JSON.stringify(
    flows.map((flow) => [
      flow.source,
      flow.values,
      flow.reasons,
      flow.protocols,
      flow.sides,
    ])
  );

/**
 * One row a pair. A row whose flows did not change since `previous` is the
 * same object, so a table and a canvas keyed on it redraw nothing for it.
 */
export function pairRows(
  reading: TrafficReading,
  previous: ReadonlyMap<string, { sig: string; row: FlowRow }> = new Map()
): { rows: FlowRow[]; kept: Map<string, { sig: string; row: FlowRow }> } {
  const { answer } = reading;
  const { failed, key } = readsOf(reading);
  const pairs = new Map<string, Flow[]>();
  for (const flow of answer.flows) {
    const from = answer.ends[flow.from];
    const to = answer.ends[flow.to];
    if (!from || !to) continue;
    const id = `${endId(from)}>${endId(to)}`;
    const held = pairs.get(id);
    if (held) held.push(flow);
    else pairs.set(id, [flow]);
  }
  const kept = new Map<string, { sig: string; row: FlowRow }>();
  const rows: FlowRow[] = [];
  for (const [id, flows] of pairs) {
    // The reading's own order is the preference order: the first source
    // that has a number is the one whose number is shown.
    flows.sort((a, b) => a.source - b.source);
    const sig = key + signature(flows);
    const was = previous.get(id);
    if (was?.sig === sig) {
      kept.set(id, was);
      rows.push(was.row);
      continue;
    }
    const from = answer.ends[flows[0].from];
    const to = answer.ends[flows[0].to];
    const requests = cellOf(flows, reading, failed, "requests");
    const drops = cellOf(flows, reading, failed, "drops");
    const row: FlowRow = {
      id,
      fromId: endId(from),
      toId: endId(to),
      from,
      to,
      requests: requests.cell,
      errorShare: errorShareOf(requests, reading, failed),
      p50: cellOf(flows, reading, failed, "p50").cell,
      p95: cellOf(flows, reading, failed, "p95").cell,
      p99: cellOf(flows, reading, failed, "p99").cell,
      bytes: cellOf(flows, reading, failed, "bytes").cell,
      events: cellOf(flows, reading, failed, "events").cell,
      drops: drops.cell,
      reasons: drops.flow?.reasons ?? [],
      seenBy: flows.map((flow) => reading.sources[flow.source]?.name ?? ""),
      by: flows.flatMap((flow) => {
        const source = reading.sources[flow.source];
        return source
          ? [
              {
                source,
                values: flow.values,
                reasons: flow.reasons,
                protocols: flow.protocols,
                sides: flow.sides,
              },
            ]
          : [];
      }),
    };
    kept.set(id, { sig, row });
    rows.push(row);
  }
  return { rows, kept };
}

/** The rows of the last reading, handed back where a pair did not change. */
export class RowMemo {
  private kept = new Map<string, { sig: string; row: FlowRow }>();

  rows(reading: TrafficReading): FlowRow[] {
    const made = pairRows(reading, this.kept);
    this.kept = made.kept;
    return made.rows;
  }
}

/** What a source's reading allows saying where it has no flow. */
export type Silence =
  | { says: "quiet" }
  /** `all`: not one of its queries answered. */
  | { says: "notRead"; said: string; all: boolean }
  /** Pods in the subject's namespace were not read, so its names were not matched. */
  | { says: "unmatched" };

/**
 * The one place that decides a source saw nothing: only where every query
 * of it answered and, about a subject in `namespace`, the names it writes
 * could be matched to workloads there. Anything else is "could not look".
 */
export function silenceOf(
  reading: TrafficReading,
  source: number,
  namespace: string | null
): Silence {
  const reads = reading.answer.reads.filter((read) => read.source === source);
  const failed = reads.find((read) => read.state.says === "failed");
  if (failed?.state.says === "failed")
    return {
      says: "notRead",
      said: failed.state.message,
      all: reads.every((read) => read.state.says === "failed"),
    };
  if (
    namespace !== null &&
    reading.sources[source]?.needsPods &&
    (reading.answer.podsFailed !== null ||
      reading.answer.podsUnread.some(
        (unread) => unread.namespace === namespace
      ))
  )
    return { says: "unmatched" };
  return { says: "quiet" };
}

/** Whether a source has any flow in this reading. */
export const heard = (reading: TrafficReading, source: number) =>
  reading.answer.flows.some((flow) => flow.source === source);

/** At or above this share of errors an edge is a warning, and at `ERROR_AT` an error. */
export const WARN_AT = 0.01;
export const ERROR_AT = 0.05;

/**
 * An edge's colour, only from what is known: a failed errors read is the
 * not-checked dash, a source without errors at all is neutral, and dropped
 * flows are never green.
 */
export function flowTone(row: FlowRow): MapTone {
  const tone = shareTone(row.errorShare);
  if ((row.drops.value ?? 0) > 0 && tone !== "err") return "warn";
  return tone;
}

/**
 * The tone of a share of errors wherever it is drawn: the edge, the table,
 * the panel and the workload block. Unread is the not-checked dash, none is
 * neutral, and a floor under the warning line is never green.
 */
export function shareTone(share: Cell): MapTone {
  if (share.state === "notRead") return "unknown";
  if (share.value === null) return "mute";
  if (share.value >= ERROR_AT) return "err";
  if (share.value >= WARN_AT) return "warn";
  return share.floor ? "mute" : "ok";
}

/** A source's own share on a pair, as its panel line says it. */
export function lineShare(line: SourceLine): Cell {
  const requests = line.values[at("requests")] ?? null;
  const errors = line.values[at("errors")] ?? null;
  const value =
    requests === null || errors === null || requests <= 0
      ? null
      : errors / requests;
  return {
    value,
    source: line.source.name,
    state: "measured",
    ...(value !== null &&
    !line.source.grpcErrors &&
    mayCarryGrpc(line.protocols)
      ? { floor: true as const }
      : {}),
  };
}

/** The number that weighs an edge, and its unit, by the first family the row has. */
export function primaryOf(
  row: FlowRow
): { unit: "requests" | "bytes" | "events"; value: number } | null {
  if (row.requests.value !== null)
    return { unit: "requests", value: row.requests.value };
  if (row.bytes.value !== null)
    return { unit: "bytes", value: row.bytes.value };
  if (row.events.value !== null)
    return { unit: "events", value: row.events.value };
  return null;
}

/** 0 to 1, log-scaled against the busiest row of the same unit. */
export function weights(rows: readonly FlowRow[]): Map<string, number> {
  const most = new Map<string, number>();
  for (const row of rows) {
    const primary = primaryOf(row);
    if (primary)
      most.set(
        primary.unit,
        Math.max(most.get(primary.unit) ?? 0, primary.value)
      );
  }
  const out = new Map<string, number>();
  for (const row of rows) {
    const primary = primaryOf(row);
    const top = primary ? (most.get(primary.unit) ?? 0) : 0;
    out.set(
      row.id,
      primary && top > 0 ? Math.log1p(primary.value) / Math.log1p(top) : 0
    );
  }
  return out;
}

/** What a live stream sends: the pairs whose last minute changed, and those it emptied. */
export interface LiveBatch {
  pairs: readonly LivePair[];
  gone: readonly LiveKey[];
  relay: RelayAt | null;
  lost: number;
  untracked: number;
  /** Nodes the relay cannot read, every one each batch. */
  unreached: readonly UnreachedNode[];
}

export interface LiveListener {
  batch: (batch: LiveBatch) => void;
  ended: (end: LiveEnd) => void;
  failed: (error: unknown) => void;
}

/** The one source a live stream is: drawn and said like any other. */
export const LIVE_SOURCE: FlowSource = {
  id: "live",
  name: "Hubble Relay",
  state: { says: "present" },
  measures: ["requests", "errors", "p50", "p95", "p99", "events", "drops"],
  found: [],
  need: "needRelay",
  marks: false,
  nodeAgent: false,
  needsPods: false,
  grpcErrors: false,
};

export const livePairId = (pair: { from: FlowEnd; to: FlowEnd }) =>
  `${endId(pair.from)}>${endId(pair.to)}`;

const measured = (value: number | null, source: string): Cell =>
  value === null
    ? { value: null, source: null, state: "measured" }
    : { value, source, state: "measured" };

/**
 * A live pair as a row. Hubble sees HTTP only where L7 visibility is on, so
 * a pair with none is "not measured" there, never 0 requests.
 */
function liveShare(pair: LivePair): Cell {
  const cell = measured(
    pair.requests && pair.errors !== null ? pair.errors / pair.requests : null,
    LIVE_SOURCE.name
  );
  return cell.value !== null && mayCarryGrpc(pair.protocols)
    ? { ...cell, floor: true }
    : cell;
}

export function liveRow(pair: LivePair): FlowRow {
  const name = LIVE_SOURCE.name;
  const http = pair.requests !== null;
  const unmeasured: Cell = { value: null, source: null, state: "notMeasured" };
  const belowHttp: Cell = { value: null, source: name, state: "belowHttp" };
  const values = MEASURES.map((measure) => {
    switch (measure) {
      case "requests":
        return pair.requests;
      case "errors":
        return pair.errors;
      case "p50":
        return pair.p50;
      case "p95":
        return pair.p95;
      case "p99":
        return pair.p99;
      case "bytes":
        return null;
      case "events":
        return pair.forwarded;
      case "drops":
        return pair.dropped;
    }
  });
  const reasons = pair.drops.map((drop: LiveDrop) => ({
    reason: drop.reason,
    rate: drop.rate,
    policies: drop.policies,
    l7: drop.l7,
  }));
  return {
    id: livePairId(pair),
    fromId: endId(pair.from),
    toId: endId(pair.to),
    from: pair.from,
    to: pair.to,
    requests: http ? measured(pair.requests, name) : belowHttp,
    errorShare: http ? liveShare(pair) : belowHttp,
    p50: http ? measured(pair.p50, name) : belowHttp,
    p95: http ? measured(pair.p95, name) : belowHttp,
    p99: http ? measured(pair.p99, name) : belowHttp,
    bytes: unmeasured,
    events: measured(pair.forwarded, name),
    drops: measured(pair.dropped, name),
    reasons,
    seenBy: [name],
    by: [
      {
        source: LIVE_SOURCE,
        values,
        reasons,
        protocols: pair.protocols,
        sides: [],
      },
    ],
  };
}

/** Live pairs as rows, each row kept for as long as its pair object is. */
export class LiveRows {
  private kept = new WeakMap<LivePair, FlowRow>();

  rows(pairs: Iterable<LivePair>): FlowRow[] {
    const out: FlowRow[] = [];
    for (const pair of pairs) {
      let row = this.kept.get(pair);
      if (!row) {
        row = liveRow(pair);
        this.kept.set(pair, row);
      }
      out.push(row);
    }
    return out;
  }
}
