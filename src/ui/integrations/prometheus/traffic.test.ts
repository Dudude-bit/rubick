import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FlowQuery, PodMarker, PromSeries } from "@/generated/types";
import type { FlowSource, FlowWindow } from "@/lib/traffic";

const prometheusQuery = vi.fn<(query: string) => Promise<PromSeries[]>>();
const prometheusFlows =
  vi.fn<
    (
      queries: FlowQuery[],
      scope: unknown,
      subject: unknown,
      markers: PodMarker[]
    ) => Promise<unknown>
  >();
vi.mock("@/lib/commands", () => ({
  commands: {
    prometheusQuery: (query: string) => prometheusQuery(query),
    prometheusFlows: (
      queries: FlowQuery[],
      scope: unknown,
      subject: unknown,
      markers: PodMarker[]
    ) => prometheusFlows(queries, scope, subject, markers),
  },
}));

const {
  beylaQueries,
  carettaQueries,
  flowSources,
  hubbleQueries,
  istioQueries,
  readFlows,
} = await import("./traffic");

type Ask = { scope: readonly string[] | null; window: FlowWindow };
const ALL: Ask = { scope: null, window: "5m" };
const SHOP: Ask = { scope: ["shop", "bank"], window: "15m" };
const istio = (scope = ALL) =>
  istioQueries(
    0,
    ["istio_requests_total", "istio_tcp_sent_bytes_total"],
    scope
  );
const of = (queries: FlowQuery[], measure: string) =>
  queries.find((query) => query.measure === measure)!.query;

describe("Istio's queries", () => {
  /**
   * A request both proxies report is counted once: the server's report
   * first, and the client's only for a pair the server did not report.
   */
  it("reads the destination's report first and the source's only where it is missing", () => {
    const requests = of(istio(), "requests");
    const destination = requests.indexOf('reporter=~"destination|waypoint"');
    const source = requests.indexOf('reporter="source"');
    expect(destination).toBeGreaterThan(-1);
    expect(source).toBeGreaterThan(destination);
    expect(requests).toContain(") or (");
    expect(requests).toContain("[5m]");
  });

  /** A flow either end of which is in scope is in scope: every end's namespace label is matched. */
  it("matches the scope on either end", () => {
    const requests = of(istio(SHOP), "requests");
    for (const label of [
      "source_workload_namespace",
      "destination_workload_namespace",
      "destination_service_namespace",
    ])
      expect(requests).toContain(`${label}=~"shop|bank"`);
    expect(requests).toContain("[15m]");
  });

  /** Errors are 5xx, and gRPC answers other than OK that did not also send a 5xx. */
  it("counts 5xx and failed gRPC as errors, once each", () => {
    const errors = of(istio(), "errors");
    expect(errors).toContain('response_code=~"5.."');
    expect(errors).toContain('grpc_response_status!="0",response_code!~"5.."');
  });

  /**
   * A share of errors over requests from another reporter can pass 100%:
   * the client's errors count only where the server reported no requests.
   */
  it("takes the client's errors only for a pair the server reported no requests for", () => {
    const errors = of(istio(), "errors");
    const [server, rest] = errors.split(") or ((");
    const [client, guard] = rest.split(" unless on(");
    expect(server).toContain('reporter=~"destination|waypoint"');
    expect(server).not.toContain('reporter="source"');
    expect(client).toContain('reporter="source"');
    expect(guard).toMatch(
      /^source_workload_namespace, source_workload, destination_workload_namespace, destination_workload, destination_service_namespace, destination_service_name\) \(sum by \([^)]*request_protocol\) \(rate\(istio_requests_total\{reporter=~"destination\|waypoint"/
    );
    expect(guard).not.toContain('reporter="source"');
  });

  /** `rate` drops a metric's name: sent and received are told apart before they are added. */
  it("adds sent and received bytes without one hiding the other", () => {
    const bytes = of(istio(), "bytes");
    expect(bytes).toContain('"rubick_way", "sent"');
    expect(bytes).toContain('"rubick_way", "received"');
  });

  /** A workload is a name with no kind, so it is matched by name and the workload-name label Istio honours. */
  it("names its ends by name, with Istio's own word for unknown", () => {
    const [requests] = istio();
    expect(requests.from.kind).toBeNull();
    expect(requests.from.unknown).toEqual(["unknown"]);
    expect(requests.to.nameLabel).toBe("service.istio.io/workload-name");
    expect(requests.to.service).toBe("destination_service_name");
  });
});

describe("the other sources' queries", () => {
  /** Beyla writes `beyla_`; the instrumentation it is built on writes `obi_` when run alone. */
  it("reads Beyla's flow bytes under either prefix", () => {
    expect(beylaQueries(0, [], ALL)[0].query).toContain(
      '__name__=~"(beyla|obi)_network_flow_bytes_total"'
    );
  });

  /**
   * One Caretta connection is a series per side, each the bytes its own
   * socket sent: read only the client's, a caller from outside the cluster
   * is never seen, and the bytes are one direction where Istio's are both.
   */
  it("adds both sides of a Caretta connection under its pair", () => {
    const [bytes] = carettaQueries(0, [], ALL);
    expect(bytes.query).not.toContain("role");
    expect(bytes.query).toMatch(
      /^sum by \(client_namespace, client_name, client_kind, server_namespace, server_name, server_kind\)/
    );
  });

  /** A flow Hubble saw arrive is preferred to the same flow seen leaving. */
  it("reads Hubble's flows where they arrived first and in milliseconds", () => {
    const queries = hubbleQueries(
      0,
      [
        "hubble_flows_processed_total",
        "hubble_http_requests_total",
        "source_workload",
      ],
      ALL
    );
    const events = of(queries, "events");
    expect(events.indexOf('traffic_direction!="egress"')).toBeLessThan(
      events.indexOf('traffic_direction="egress"')
    );
    expect(of(queries, "p95")).toMatch(/\* 1000\)?$/);
    expect(events).toContain("source_workload_kind");
    const [, client] = of(queries, "errors").split(") or ((");
    expect(client).toMatch(
      /reporter="client".* unless on\(source_namespace, source_workload, source_workload_kind, destination_namespace, destination_workload, destination_workload_kind\) \(.*reporter!="client"/
    );
  });
});

describe("which sources a Prometheus holds", () => {
  beforeEach(() => {
    prometheusQuery.mockReset();
    prometheusFlows.mockReset();
  });

  const named = (...names: string[]): PromSeries[] =>
    names.map((name) => ({
      labels: { __name__: name },
      points: [{ t: 0, v: 1 }],
    }));

  /**
   * Hubble's series without a source or destination are their own state:
   * it is installed, and its metrics cannot draw a flow.
   */
  it("tells present, absent, unpaired and failed apart", async () => {
    prometheusQuery.mockImplementation(async (query) => {
      if (query.includes("istio_requests_total"))
        return named("istio_requests_total");
      if (query.includes("hubble") && query.startsWith("count by"))
        return named("hubble_flows_processed_total");
      if (query.includes("hubble")) return [];
      if (query.includes("beyla")) throw new Error("bad_data");
      return [];
    });
    const sources = await flowSources();
    const state = Object.fromEntries(sources.map((s) => [s.id, s.state]));
    expect(state).toEqual({
      istio: { says: "present" },
      hubble: { says: "unpaired" },
      beyla: { says: "failed", said: "bad_data" },
      caretta: { says: "absent" },
    });
  });

  /**
   * A source whose ends only the pods resolve must say so, or a subject in a
   * namespace whose pods were not read is called quiet: Istio always (a pod
   * label), Hubble by pod, never one that writes the workload's kind.
   */
  it("says which sources name workloads only through their pods", async () => {
    const hubbleBy = async (label: "workload" | "pod") => {
      prometheusQuery.mockImplementation(async (query) => {
        if (query.includes("istio_requests_total"))
          return named("istio_requests_total");
        if (query.includes("hubble") && query.startsWith("count by"))
          return named("hubble_flows_processed_total");
        if (query.includes(`destination_${label}!=""`))
          return [{ labels: {}, points: [{ t: 0, v: 3 }] }];
        if (query.includes("beyla"))
          return named("beyla_network_flow_bytes_total");
        if (query.includes("caretta")) return named("caretta_links_observed");
        return [];
      });
      const sources = await flowSources();
      return Object.fromEntries(sources.map((s) => [s.id, s.needsPods]));
    };
    expect(await hubbleBy("workload")).toEqual({
      istio: true,
      hubble: false,
      beyla: false,
      caretta: false,
    });
    expect((await hubbleBy("pod")).hubble).toBe(true);
  });

  /** Only the present sources are asked, positionally, and only Istio marks pods. */
  it("asks only present sources and numbers them as it hands them back", async () => {
    prometheusFlows.mockResolvedValue({ ends: [], flows: [] });
    const present = (id: string, found: string[]): FlowSource => ({
      id,
      name: id,
      state: { says: "present" },
      measures: [],
      found,
      need: "needIstio",
      marks: id === "istio",
      nodeAgent: false,
      needsPods: false,
    });
    const absent = {
      ...present("hubble", []),
      state: { says: "absent" as const },
    };
    const reading = await readFlows({
      scope: null,
      window: "5m",
      subject: null,
      sources: [
        absent,
        present("caretta", ["caretta_links_observed"]),
        present("istio", ["istio_requests_total"]),
      ],
    });
    const [queries, , , markers] = prometheusFlows.mock.calls[0];
    expect(reading.sources.map((s) => s.id)).toEqual(["caretta", "istio"]);
    expect(new Set(queries.map((query) => query.source))).toEqual(
      new Set([0, 1])
    );
    expect(
      queries
        .filter((query) => query.source === 0)
        .every((q) => q.query.includes("caretta"))
    ).toBe(true);
    expect(markers).toEqual([
      {
        source: 1,
        containers: ["istio-proxy"],
        annotated: ["ambient.istio.io/redirection"],
      },
    ]);
  });
});
