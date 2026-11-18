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
   * A call that failed before it reached the server (UF, UH, UO) is in the
   * caller's proxy's report only: it is added to the server's, matched by
   * pair, code and flags so a call both report is counted once, and each
   * series says which side it came from.
   */
  it("adds the calls only the caller's proxy reported to the server's, each tagged with its side", () => {
    const [requests] = istio();
    expect(requests.side).toBe("rubick_side");
    const call =
      "source_workload_namespace, source_workload, destination_workload_namespace, destination_workload, destination_service_namespace, destination_service_name, request_protocol, response_code, response_flags, grpc_response_status";
    const [server, rest] = requests.query.split(" or (label_replace(");
    const [caller, guard] = rest.split(" unless on(");
    expect(server).toContain('reporter=~"destination|waypoint"');
    expect(server).toContain('"rubick_side", "server"');
    expect(server).not.toContain('reporter="source"');
    expect(caller).toContain('reporter="source"');
    expect(caller).toContain('"rubick_side", "caller"');
    expect(guard.startsWith(`${call}) sum by (${call}) (`)).toBe(true);
    expect(guard).toContain('reporter=~"destination|waypoint"');
    expect(guard).not.toContain('reporter="source"');
  });

  /**
   * Errors and latency are over the same calls as requests: a share of the
   * server's errors over both sides' requests, or the reverse, misstates it.
   */
  it("takes errors and latency from the same calls as requests", () => {
    const errors = of(istio(), "errors");
    const guards = errors.split(" unless on(").slice(1);
    expect(guards).toHaveLength(2);
    for (const guard of guards) {
      expect(guard.startsWith("source_workload_namespace,")).toBe(true);
      expect(guard.split(")")[0]).toContain("response_flags");
      expect(guard.split(" or ")[0]).not.toContain('reporter="source"');
    }
    const p95 = of(istio(), "p95");
    expect(p95).toContain('reporter="source"');
    expect(p95).toContain(" unless on(le, source_workload_namespace,");
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
        "hubble_flows_processed_total{source_workload}",
        "hubble_http_requests_total{source_workload}",
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
      /reporter="client".* unless on\(source_namespace, source_workload, source_workload_kind, destination_namespace, destination_workload, destination_workload_kind, protocol\) \(.*reporter!="client"/
    );
  });
});

describe("Hubble's ends, metric by metric", () => {
  beforeEach(() => {
    prometheusQuery.mockReset();
  });

  /**
   * Cilium sets the labels each metric names its ends by: HTTP by workload
   * and flows by pod is one cluster, and summing the flows by workload
   * labels they do not carry leaves every flow with no end.
   */
  it("sums each metric by the labels it carries, workload or pod", async () => {
    prometheusQuery.mockImplementation(async (query) => {
      const names = (...n: string[]): PromSeries[] =>
        n.map((name) => ({
          labels: { __name__: name },
          points: [{ t: 0, v: 1 }],
        }));
      if (!query.includes("hubble")) return [];
      if (query.includes('destination_workload!=""'))
        return names("hubble_http_requests_total");
      if (query.includes('destination_pod!=""'))
        return names("hubble_flows_processed_total");
      return names(
        "hubble_flows_processed_total",
        "hubble_http_requests_total"
      );
    });
    const hubble = (await flowSources()).find((s) => s.id === "hubble")!;
    expect(hubble.state).toEqual({ says: "present" });
    expect(hubble.needsPods).toBe(true);
    const queries = hubbleQueries(0, hubble.found, ALL);
    expect(of(queries, "events")).toMatch(
      /^\(sum by \(source_namespace, source_pod, destination_namespace, destination_pod\)/
    );
    expect(of(queries, "requests")).toMatch(
      /^\(sum by \(source_namespace, source_workload, source_workload_kind, destination_namespace, destination_workload, destination_workload_kind, protocol\)/
    );
  });
});

describe("Hubble's HTTP metrics, v1 and v2", () => {
  /**
   * The server reporting HTTP/1.1 and the client alone HTTP/2 with two 5xx:
   * requests count the client's HTTP/2, so its errors must count too. Keyed
   * on the pair alone, the server's HTTP/1.1 hid them and the share read 0%.
   */
  it("keeps a client's errors on a protocol the server did not report", () => {
    const queries = hubbleQueries(
      0,
      ["hubble_http_requests_total{source_workload}"],
      ALL
    );
    const errors = of(queries, "errors");
    expect(errors).toMatch(/^\(sum by \([^)]*, protocol\)/);
    expect(errors).toMatch(/unless on\([^)]*, protocol\)/);
  });

  /**
   * HTTP v1 writes `status` only on its responses: a 5xx share read from
   * its requests finds none and reads 0% where half the calls failed.
   */
  it("reads HTTP v1's calls and 5xx from its responses and httpV2's from its requests", () => {
    const v1 = hubbleQueries(
      0,
      [
        "hubble_http_requests_total{source_workload}",
        "hubble_http_responses_total{source_workload}",
      ],
      ALL
    );
    const v2 = hubbleQueries(
      0,
      ["hubble_http_requests_total{source_workload}"],
      ALL
    );
    for (const measure of ["requests", "errors"]) {
      expect(of(v1, measure)).toContain("hubble_http_responses_total{");
      expect(of(v1, measure)).not.toContain("hubble_http_requests_total");
      expect(of(v2, measure)).toContain("hubble_http_requests_total{");
    }
    expect(of(v1, "errors")).toContain('status=~"5.."');
  });

  /**
   * HTTP v1 labels a response as it went, from api back to web; read as
   * written, every v1 call and its latency was drawn backwards. httpV2
   * inverts its labels to the call's own direction, and is read as written.
   */
  it("reads HTTP v1's responses and latency from the caller to the server", () => {
    const response = {
      source_namespace: "shop",
      source_workload: "api",
      destination_namespace: "shop",
      destination_workload: "web",
    } as Record<string, string>;
    const ends = (found: string[]) =>
      hubbleQueries(0, found, ALL)
        .filter((q) => ["requests", "errors", "p95"].includes(q.measure))
        .map((q) => [response[q.from.name!], response[q.to.name!]]);
    const v1 = ends([
      "hubble_http_requests_total{source_workload}",
      "hubble_http_responses_total{source_workload}",
    ]);
    expect(v1).toHaveLength(3);
    for (const pair of v1) expect(pair).toEqual(["web", "api"]);
    for (const pair of ends(["hubble_http_requests_total{source_workload}"]))
      expect(pair).toEqual(["api", "web"]);
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
      if (query.includes("hubble") && !query.includes("!="))
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
   * A source whose ends the pods resolve must say so, or a subject in a
   * namespace whose pods were not read is called quiet: Istio always (a pod
   * label), Hubble by pod, Beyla and Caretta for an end they name as a bare
   * pod; only Hubble writing every metric's workload kind needs none.
   */
  it("says which sources need the pods to name some of their ends", async () => {
    const hubbleBy = async (label: "workload" | "pod") => {
      prometheusQuery.mockImplementation(async (query) => {
        if (query.includes("istio_requests_total"))
          return named("istio_requests_total");
        if (query.includes(`destination_${label}!=""`))
          return named("hubble_flows_processed_total");
        if (query.includes("hubble") && !query.includes("!="))
          return named("hubble_flows_processed_total");
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
      beyla: true,
      caretta: true,
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
      grpcErrors: false,
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
