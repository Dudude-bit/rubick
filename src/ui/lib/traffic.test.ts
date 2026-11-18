import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type {
  Flow,
  FlowEnd,
  LivePair,
  Measure,
  QueryRead,
} from "@/generated/types";
import {
  flowTone,
  liveRow,
  LiveRows,
  MAX_FLOW_ROWS,
  MEASURES,
  pairRows,
  RowMemo,
  silenceOf,
  weights,
  type FlowSource,
  type TrafficReading,
} from "./traffic";

const source = (name: string, measures: readonly Measure[]): FlowSource => ({
  id: name.toLowerCase(),
  name,
  state: { says: "present" },
  measures,
  found: [],
  need: "needIstio",
  marks: false,
  nodeAgent: false,
  needsPods: false,
  grpcErrors: name === "Istio",
});

const ISTIO = source("Istio", [
  "requests",
  "errors",
  "p50",
  "p95",
  "p99",
  "bytes",
]);
const HUBBLE = source("Hubble", ["events", "drops"]);
const CARETTA = source("Caretta", ["bytes"]);

const workload = (name: string): FlowEnd => ({
  is: "workload",
  key: { namespace: "shop", group: "apps", kind: "Deployment", name },
});

const values = (set: Partial<Record<Measure, number>>) =>
  MEASURES.map((measure) => set[measure] ?? null);

const flow = (at: number, set: Partial<Record<Measure, number>>): Flow => ({
  source: at,
  from: 0,
  to: 1,
  protocols: [],
  sides: [],
  values: values(set),
  reasons: [],
});

function reading(
  sources: FlowSource[],
  flows: Flow[],
  reads: QueryRead[] = []
): TrafficReading {
  return {
    sources,
    window: "5m",
    answer: {
      ends: [workload("cart"), workload("pay")],
      flows,
      reads,
      observed: null,
      coverage: [],
      podsUnread: [],
      podsFailed: null,
      cut: 0,
    },
  };
}

const failed = (at: number, measure: Measure): QueryRead => ({
  source: at,
  measure,
  state: { says: "failed", code: "CONNECTION", message: "timed out after 20s" },
});

describe("the rows the page and the block draw", () => {
  /**
   * Two sources on one pair are two counts of the same thing: adding them
   * would double it, so each number is one source's and says which.
   */
  it("takes each number from one source and never adds two sources", () => {
    const [row] = pairRows(
      reading(
        [ISTIO, CARETTA],
        [
          flow(0, { requests: 4, errors: 0, bytes: 100 }),
          flow(1, { bytes: 300 }),
        ]
      )
    ).rows;
    expect(row.bytes).toEqual({
      value: 100,
      source: "Istio",
      state: "measured",
    });
    expect(row.seenBy).toEqual(["Istio", "Caretta"]);
    expect(row.by.map((line) => line.source.name)).toEqual([
      "Istio",
      "Caretta",
    ]);
  });

  /**
   * A column no source that saw the pair measures is empty for that reason,
   * and one whose read failed says so: neither is a zero.
   */
  it("says not measured, not read and measured-but-none apart", () => {
    const [onlyBytes] = pairRows(
      reading([CARETTA], [flow(0, { bytes: 9 })])
    ).rows;
    expect(onlyBytes.requests.state).toBe("notMeasured");
    expect(onlyBytes.p95.state).toBe("notMeasured");

    const [unread] = pairRows(
      reading([ISTIO], [flow(0, { requests: 2 })], [failed(0, "p95")])
    ).rows;
    expect(unread.p95).toEqual({
      value: null,
      source: "Istio",
      state: "notRead",
    });

    const [idle] = pairRows(
      reading([ISTIO], [flow(0, { requests: 0, errors: 0 })])
    ).rows;
    expect(idle.p95).toEqual({ value: null, source: null, state: "measured" });
  });

  /**
   * A source whose query failed has no flow on any pair, so a pair only
   * another source saw would otherwise call its requests none, or not measured.
   */
  it("says not read where the source measuring it failed and so has no flow on the pair", () => {
    const hubbleHttp = source("Hubble", ["events", "requests"]);
    for (const other of [hubbleHttp, HUBBLE]) {
      const [row] = pairRows(
        reading(
          [ISTIO, other],
          [flow(1, { events: 3 })],
          [failed(0, "requests")]
        )
      ).rows;
      expect(row.requests).toEqual({
        value: null,
        source: "Istio",
        state: "notRead",
      });
      expect(row.errorShare.state).toBe("notRead");
    }
  });

  /**
   * A pair Hubble's HTTP metric has no series for is one no L7 rule shows
   * it: its requests, errors and latency are not counted, not "none", in
   * the window as in Live; a pair whose HTTP was idle stays "none".
   */
  it("says a windowed pair a source sees only below HTTP is that, not none", () => {
    const hubble = source("Hubble", [
      "events",
      "drops",
      "requests",
      "errors",
      "p95",
    ]);
    const [l4] = pairRows(
      reading([hubble], [flow(0, { events: 3, errors: 0, drops: 0 })])
    ).rows;
    for (const cell of [l4.requests, l4.errorShare, l4.p95])
      expect(cell.state).toBe("belowHttp");
    expect(l4.events.value).toBe(3);
    expect(flowTone(l4)).toBe("mute");
    const [idle] = pairRows(
      reading([hubble], [flow(0, { events: 3, requests: 0, errors: 0 })])
    ).rows;
    expect(idle.p95.state).toBe("measured");
  });

  /** A read that fails with the pair's flows unchanged must not hand back the row that said "none". */
  it("draws a row again when a read failed though its flows did not change", () => {
    const memo = new RowMemo();
    const flows = [flow(1, { events: 3 })];
    const [before] = memo.rows(reading([ISTIO, HUBBLE], flows));
    const [after] = memo.rows(
      reading([ISTIO, HUBBLE], flows, [failed(0, "requests")])
    );
    expect(before.requests.state).toBe("notMeasured");
    expect(after.requests.state).toBe("notRead");
  });

  /**
   * Hubble's errors are HTTP 5xx: a pair that may carry gRPC has only a floor
   * from it, while Istio counts gRPC statuses and vouches for its share.
   */
  it("takes a share as a floor from a source that cannot see gRPC fail", () => {
    const hubble = source("Hubble", ["requests", "errors"]);
    const on = (from: FlowSource, protocols: string[], errors = 0) =>
      pairRows(
        reading([from], [{ ...flow(0, { requests: 10, errors }), protocols }])
      ).rows[0];
    expect(on(hubble, ["HTTP/2"]).errorShare.floor).toBe(true);
    expect(flowTone(on(hubble, ["HTTP/2"]))).toBe("mute");
    expect(flowTone(on(hubble, ["HTTP/2"], 1))).toBe("err");
    expect(on(hubble, ["HTTP/1.1"]).errorShare.floor).toBeUndefined();
    expect(flowTone(on(ISTIO, ["grpc"]))).toBe("ok");
  });

  /** The share of errors is over the same source's requests, and unknown where its errors were not read. */
  it("works the error share out of one source and leaves it unknown when its errors failed", () => {
    const [row] = pairRows(
      reading([ISTIO], [flow(0, { requests: 10, errors: 1 })])
    ).rows;
    expect(row.errorShare).toEqual({
      value: 0.1,
      source: "Istio",
      state: "measured",
    });
    const [unread] = pairRows(
      reading([ISTIO], [flow(0, { requests: 10 })], [failed(0, "errors")])
    ).rows;
    expect(unread.errorShare.state).toBe("notRead");
    expect(unread.errorShare.value).toBeNull();
  });

  /** A pair whose numbers did not move keeps its row, so nothing redraws for it. */
  it("hands back the same row for a pair that did not change", () => {
    const memo = new RowMemo();
    const first = memo.rows(reading([ISTIO], [flow(0, { requests: 3 })]));
    const same = memo.rows(reading([ISTIO], [flow(0, { requests: 3 })]));
    const moved = memo.rows(reading([ISTIO], [flow(0, { requests: 4 })]));
    expect(same[0]).toBe(first[0]);
    expect(moved[0]).not.toBe(first[0]);
  });
});

describe("an edge's colour", () => {
  const row = (
    set: Partial<Record<Measure, number>>,
    sources = [ISTIO],
    reads: QueryRead[] = []
  ) => pairRows(reading(sources, [flow(0, set)], reads)).rows[0];

  /**
   * Green is earned by an error share someone read: a source with no
   * errors at all is neutral, and a failed read is the not-checked dash.
   */
  it("is never ok without a share of errors that was read", () => {
    expect(flowTone(row({ bytes: 5 }, [CARETTA]))).toBe("mute");
    expect(flowTone(row({ requests: 5 }, [ISTIO], [failed(0, "errors")]))).toBe(
      "unknown"
    );
    expect(flowTone(row({ requests: 100, errors: 0 }))).toBe("ok");
    expect(flowTone(row({ requests: 100, errors: 1 }))).toBe("warn");
    expect(flowTone(row({ requests: 100, errors: 5 }))).toBe("err");
  });

  /** Dropped flows are never drawn green, whatever else the pair says. */
  it("warns where flows were dropped", () => {
    expect(flowTone(row({ events: 3, drops: 0.5 }, [HUBBLE]))).toBe("warn");
    expect(flowTone(row({ events: 3, drops: 0 }, [HUBBLE]))).toBe("mute");
  });
});

describe("an edge's weight", () => {
  /** Requests and bytes are not one scale: each edge is weighed against the busiest of its own unit. */
  it("is log-scaled against the busiest edge of the same unit", () => {
    const read = reading([ISTIO, CARETTA], []);
    read.answer.ends.push(workload("db"));
    read.answer.flows = [
      flow(0, { requests: 99 }),
      { ...flow(1, { bytes: 1_000_000 }), from: 1, to: 2 },
    ];
    const rows = pairRows(read).rows;
    const weight = weights(rows);
    expect(rows.map((row) => weight.get(row.id))).toEqual([1, 1]);
  });
});

describe("the budget both sides of IPC hold", () => {
  /** `src/contracts/traffic-budget.json` is the other half of the row cap and the order of `values`. */
  it("matches src/contracts/traffic-budget.json", () => {
    const budget = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "src/contracts/traffic-budget.json"),
        "utf8"
      )
    ) as { maxFlowRows: number; measures: string[] };
    expect(budget.maxFlowRows).toBe(MAX_FLOW_ROWS);
    expect(budget.measures).toEqual([...MEASURES]);
  });
});

describe("a live pair as a row", () => {
  const pair = (over: Partial<LivePair> = {}): LivePair => ({
    from: workload("cart"),
    to: workload("pay"),
    forwarded: 3,
    dropped: 0.5,
    drops: [
      {
        reason: "POLICY_DENIED",
        rate: 0.5,
        policies: [
          {
            group: "networking.k8s.io",
            kind: "NetworkPolicy",
            namespace: "shop",
            name: "deny-all",
          },
        ],
        l7: false,
      },
    ],
    requests: null,
    errors: null,
    p50: null,
    p95: null,
    p99: null,
    protocols: [],
    ...over,
  });

  /**
   * Hubble sees HTTP only where L7 visibility is on: a pair it saw no HTTP
   * on is seen below HTTP, never "none" requests.
   */
  it("says a live pair with no HTTP is seen below it, and keeps drops with their policy", () => {
    const row = liveRow(pair());
    expect(row.requests.state).toBe("belowHttp");
    expect(row.errorShare.state).toBe("belowHttp");
    expect(row.p95.state).toBe("belowHttp");
    expect(row.events).toEqual({
      value: 3,
      source: "Hubble Relay",
      state: "measured",
    });
    expect(row.reasons[0].policies?.[0].name).toBe("deny-all");
    expect(flowTone(row)).toBe("warn");
    const http = liveRow(pair({ requests: 10, errors: 1, p95: 12 }));
    expect(http.errorShare.value).toBe(0.1);
    expect(http.p95.value).toBe(12);
  });

  /**
   * A failed gRPC call answers HTTP 200: over HTTP/2 the share Hubble counts
   * is only a floor, and a floor under the warning line is never green.
   */
  it("calls a share over HTTP/2 a floor and never paints it ok", () => {
    const grpc = liveRow(
      pair({
        dropped: 0,
        drops: [],
        requests: 10,
        errors: 0,
        protocols: ["HTTP/2"],
      })
    );
    expect(grpc.errorShare.floor).toBe(true);
    expect(flowTone(grpc)).toBe("mute");
    const plain = liveRow(
      pair({
        dropped: 0,
        drops: [],
        requests: 10,
        errors: 0,
        protocols: ["HTTP/1.1"],
      })
    );
    expect(plain.errorShare.floor).toBeUndefined();
    expect(flowTone(plain)).toBe("ok");
  });

  /** A pair object the stream did not resend keeps its row, so it does not redraw. */
  it("keeps a row for as long as its pair object", () => {
    const rows = new LiveRows();
    const one = pair();
    const [first] = rows.rows([one]);
    expect(rows.rows([one])[0]).toBe(first);
    expect(rows.rows([pair()])[0]).not.toBe(first);
  });
});

describe("what a source with no flow allows saying", () => {
  const withPods = (
    sources: FlowSource[],
    pods: Pick<TrafficReading["answer"], "podsUnread" | "podsFailed">
  ): TrafficReading => {
    const read = reading(sources, []);
    return { ...read, answer: { ...read.answer, ...pods } };
  };
  const unreadShop = {
    podsUnread: [
      { namespace: "shop", code: "FORBIDDEN", message: "forbidden" },
    ],
    podsFailed: null,
  };

  /** Only a source every query of which answered saw nothing; a failed read is "could not look". */
  it("is quiet only where every query answered", () => {
    expect(silenceOf(reading([ISTIO], []), 0, null)).toEqual({ says: "quiet" });
    expect(
      silenceOf(
        reading(
          [ISTIO],
          [],
          [
            { source: 0, measure: "requests", state: { says: "noSeries" } },
            failed(0, "p95"),
          ]
        ),
        0,
        "shop"
      )
    ).toEqual({ says: "notRead", said: "timed out after 20s", all: false });
    expect(
      silenceOf(
        reading([ISTIO], [], [failed(0, "requests"), failed(0, "bytes")]),
        0,
        null
      )
    ).toMatchObject({ says: "notRead", all: true });
  });

  /**
   * A source whose names only the pods resolve cannot find a subject whose
   * namespace's pods were not read; one that writes the kind can.
   */
  it("is unmatched for a source that needs the pods the subject's namespace hid", () => {
    const istio = { ...ISTIO, needsPods: true };
    expect(silenceOf(withPods([istio], unreadShop), 0, "shop")).toEqual({
      says: "unmatched",
    });
    expect(
      silenceOf(
        withPods([istio], {
          podsUnread: [],
          podsFailed: { code: "FORBIDDEN", message: "forbidden" },
        }),
        0,
        "shop"
      )
    ).toEqual({ says: "unmatched" });
    expect(silenceOf(withPods([istio], unreadShop), 0, "web")).toEqual({
      says: "quiet",
    });
    expect(silenceOf(withPods([CARETTA], unreadShop), 0, "shop")).toEqual({
      says: "quiet",
    });
    expect(silenceOf(withPods([istio], unreadShop), 0, null)).toEqual({
      says: "quiet",
    });
  });
});
