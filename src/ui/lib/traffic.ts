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
  | { says: "failed"; said: string };

/** A source of flows, as the supplier found it. */
export interface FlowSource {
  /** The supplier's own; a surface prints `name` and never branches on this. */
  id: string;
  name: string;
  state: FlowSourceState;
  /** What it can measure: a column it leaves empty says so, never 0. */
  measures: readonly Measure[];
  /** The metric names it found, for the rail. */
  found: readonly string[];
  /** What it needs to have series here. */
  need: TrafficWord;
  /** It sees only pods it marks, and the answer says how many it marks. */
  marks: boolean;
  /** It sees only the nodes its agent runs on, which nothing here can tell. */
  nodeAgent: boolean;
}

/** One read: the present sources, positionally as each flow's `source`. */
export interface TrafficReading {
  sources: readonly FlowSource[];
  answer: TrafficAnswer;
  window: FlowWindow;
}

export type CellState = "measured" | "notMeasured" | "notRead";

/** One number on a row, the source it came from, or why there is none. */
export interface Cell {
  value: number | null;
  source: string | null;
  state: CellState;
}

/** Why flows were dropped, and the policies that denied them where the source says. */
export interface Reason {
  reason: string;
  rate: number;
  policies?: readonly PolicyRef[];
}

/** One source's own numbers on a pair, for the panel. */
export interface SourceLine {
  source: FlowSource;
  values: readonly (number | null)[];
  reasons: readonly Reason[];
  protocols: readonly string[];
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
  return (source: number, measure: Measure) =>
    failed.has(`${source}:${measure}`);
}

/**
 * A cell from the first source, in the reading's order, that has the number;
 * where none has it, "not read" if a source that saw the pair failed to read
 * it, "not measured" if none of them measures it at all.
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
  const unread = measuring.find((flow) => failed(flow.source, measure));
  return {
    cell: {
      value: null,
      source: unread ? (reading.sources[unread.source]?.name ?? null) : null,
      state: unread
        ? "notRead"
        : measuring.length > 0
          ? "measured"
          : "notMeasured",
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
  const source = reading.sources[flow.source]?.name ?? null;
  if (failed(flow.source, "errors"))
    return { value: null, source, state: "notRead" };
  const errors = flow.values[at("errors")];
  const total = requests.cell.value ?? 0;
  return {
    value:
      errors === null || errors === undefined || total <= 0
        ? null
        : errors / total,
    source,
    state: "measured",
  };
}

const signature = (flows: readonly Flow[]) =>
  JSON.stringify(
    flows.map((flow) => [
      flow.source,
      flow.values,
      flow.reasons,
      flow.protocols,
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
  const failed = readsOf(reading);
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
    const sig = signature(flows);
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

/** At or above this share of errors an edge is a warning, and at `ERROR_AT` an error. */
export const WARN_AT = 0.01;
export const ERROR_AT = 0.05;

/**
 * An edge's colour, only from what is known: a failed errors read is the
 * not-checked dash, a source without errors at all is neutral, and dropped
 * flows are never green.
 */
export function flowTone(row: FlowRow): MapTone {
  const share = row.errorShare;
  const shareTone: MapTone =
    share.state === "notRead"
      ? "unknown"
      : share.value === null
        ? "mute"
        : share.value >= ERROR_AT
          ? "err"
          : share.value >= WARN_AT
            ? "warn"
            : "ok";
  if ((row.drops.value ?? 0) > 0 && shareTone !== "err") return "warn";
  return shareTone;
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
export function liveRow(pair: LivePair): FlowRow {
  const name = LIVE_SOURCE.name;
  const http = pair.requests !== null;
  const unmeasured: Cell = { value: null, source: null, state: "notMeasured" };
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
  }));
  return {
    id: livePairId(pair),
    fromId: endId(pair.from),
    toId: endId(pair.to),
    from: pair.from,
    to: pair.to,
    requests: http ? measured(pair.requests, name) : unmeasured,
    errorShare: http
      ? measured(
          pair.requests && pair.errors !== null
            ? pair.errors / pair.requests
            : null,
          name
        )
      : unmeasured,
    p50: http ? measured(pair.p50, name) : unmeasured,
    p95: http ? measured(pair.p95, name) : unmeasured,
    p99: http ? measured(pair.p99, name) : unmeasured,
    bytes: unmeasured,
    events: measured(pair.forwarded, name),
    drops: measured(pair.dropped, name),
    reasons,
    seenBy: [name],
    by: [{ source: LIVE_SOURCE, values, reasons, protocols: pair.protocols }],
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
