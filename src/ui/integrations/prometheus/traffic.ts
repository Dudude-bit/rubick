/**
 * Flows between workloads, from the four sources whose series name both
 * ends. Each source's names, labels and units, fetched 2026-11-14:
 *
 * - Istio (istio.io/latest/docs/reference/config/metrics/):
 *   `istio_requests_total`, `istio_request_duration_milliseconds` (ms),
 *   `istio_tcp_{sent,received}_bytes_total`; a workload is a name without a
 *   kind, `unknown` where missing. `reporter` is `destination` from the
 *   server's proxy (ztunnel's inbound too) and `source` from the client's.
 * - Hubble (docs.cilium.io/en/stable/observability/metrics/):
 *   `hubble_flows_processed_total`, `hubble_drop_total{reason}`, httpV2's
 *   `hubble_http_requests_total{status,reporter}` and
 *   `hubble_http_request_duration_seconds`; ends only through `labelsContext`.
 * - Beyla (grafana/beyla `pkg/beyla/config_obi.go`): `beyla.network.flow.bytes`,
 *   a counter, `beyla_network_flow_bytes_total` in Prometheus (OBI alone
 *   writes `obi_`); by default `k8s_{src,dst}_owner_name` and `_namespace`.
 * - Caretta (groundcover-com/caretta `pkg/caretta/caretta.go`): the gauge
 *   `caretta_links_observed`, bytes sent since it started, one series per
 *   link and `role` (1 client, 2 server).
 *
 * Every query is summed by the labels that name its ends; Rust resolves them
 * (`prometheus_flows`). Where two reporters see one request the first wins
 * by `or`, which keeps a right-hand series only where the left has none.
 */
import type {
  EndLabels,
  FlowQuery,
  Measure,
  PodMarker,
  WorkloadKey,
} from "@/generated/types";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type {
  FlowSource,
  FlowWindow,
  TrafficReading,
  TrafficWord,
} from "@/lib/traffic";
import { escapeLabel, escapeRegex } from "./queries";

interface Ask {
  scope: readonly string[] | null;
  window: FlowWindow;
}

const end = (labels: Partial<EndLabels>): EndLabels => ({
  namespace: null,
  kind: null,
  name: null,
  pod: null,
  service: null,
  serviceNamespace: null,
  address: null,
  nameLabel: null,
  kindAs: [],
  unknown: [],
  ...labels,
});

/** `rate(m{…}[w])`, once per label the scope is matched on, `or`-ed: a flow either end of which is in scope. */
export function scoped(
  metric: string,
  matchers: readonly string[],
  scopeOn: readonly string[],
  ask: Ask,
  fn = "rate"
): string {
  const selector = (more: readonly string[]) => {
    const all = [...matchers, ...more];
    return metric.startsWith("{")
      ? `{${[metric.slice(1, -1), ...all].join(",")}}`
      : `${metric}{${all.join(",")}}`;
  };
  if (ask.scope === null) return `${fn}(${selector([])}[${ask.window}])`;
  const names = `"${escapeLabel(ask.scope.map(escapeRegex).join("|"))}"`;
  return scopeOn
    .map((label) => `${fn}(${selector([`${label}=~${names}`])}[${ask.window}])`)
    .join(" or ");
}

const sum = (by: readonly string[], inner: string) =>
  `sum by (${by.join(", ")}) (${inner})`;

/** The first answer for a label set, and the next only where the first has none. */
const first = (...branches: string[]) =>
  branches.map((branch) => `(${branch})`).join(" or ");

/**
 * Each reporter's answer only on pairs no earlier reporter counted
 * `requests` for: what is divided by requests comes from the same reporter.
 */
const sameReporterAs = (
  pair: readonly string[],
  requests: readonly string[],
  answers: readonly string[]
) =>
  answers
    .map((answer, i) =>
      i === 0
        ? `(${answer})`
        : `((${answer}) unless on(${pair.join(", ")}) (${requests.slice(0, i).join(" or ")}))`
    )
    .join(" or ");

interface Definition {
  id: string;
  name: string;
  need: TrafficWord;
  marks: boolean;
  nodeAgent: boolean;
  grpcErrors: boolean;
  presence: string[];
  /** From what the presence queries found, its state and what it measures. */
  judge: (
    found: readonly string[][]
  ) => Pick<FlowSource, "state" | "measures" | "found" | "needsPods">;
  queries: (source: number, found: readonly string[], ask: Ask) => FlowQuery[];
  marker?: Omit<PodMarker, "source">;
}

const query = (
  source: number,
  measure: Measure,
  promql: string,
  from: EndLabels,
  to: EndLabels,
  more: Partial<FlowQuery> = {}
): FlowQuery => ({
  source,
  measure,
  query: promql,
  from,
  to,
  protocol: null,
  reason: null,
  side: null,
  zeroWhenAbsent: measure === "errors" || measure === "drops",
  ...more,
});

const QUANTILES = [
  ["p50", "0.5"],
  ["p95", "0.95"],
  ["p99", "0.99"],
] as const;

const ISTIO_PAIR = [
  "source_workload_namespace",
  "source_workload",
  "destination_workload_namespace",
  "destination_workload",
  "destination_service_namespace",
  "destination_service_name",
];
const ISTIO_SCOPE = [
  "source_workload_namespace",
  "destination_workload_namespace",
  "destination_service_namespace",
];
const ISTIO_FROM = end({
  namespace: "source_workload_namespace",
  name: "source_workload",
  nameLabel: "service.istio.io/workload-name",
  unknown: ["unknown"],
});
const ISTIO_TO = end({
  namespace: "destination_workload_namespace",
  name: "destination_workload",
  service: "destination_service_name",
  serviceNamespace: "destination_service_namespace",
  nameLabel: "service.istio.io/workload-name",
  unknown: ["unknown"],
});
/** The server's own proxy, ztunnel's inbound or a waypoint, before the client's. */
const REPORTERS = ['reporter=~"destination|waypoint"', 'reporter="source"'];
/** A call as both proxies report it: one series a pair, code and flags. */
const ISTIO_CALL = [
  ...ISTIO_PAIR,
  "request_protocol",
  "response_code",
  "response_flags",
  "grpc_response_status",
];
const SIDE = "rubick_side";

/**
 * The server's proxy and the caller's report the same calls; the caller's
 * alone holds a call that failed before it reached the server (UF, UH, UO,
 * URX). The server's series are taken, and the caller's added where the
 * server has none of the same pair, code and flags, as Kiali's graph merges
 * them (graph/telemetry/istio/istio.go). `tagged` names each series' side.
 */
function bothSides(
  metric: string,
  matchers: readonly string[],
  call: readonly string[],
  ask: Ask,
  tagged = false
): string {
  const [server, caller] = REPORTERS.map((r) =>
    sum(call, scoped(metric, [r, ...matchers], ISTIO_SCOPE, ask))
  );
  const tag = (q: string, as: string) =>
    tagged ? `label_replace(${q}, "${SIDE}", "${as}", "", "")` : q;
  return `${tag(server, "server")} or (${tag(caller, "caller")} unless on(${call.join(", ")}) ${server})`;
}

export function istioQueries(
  source: number,
  found: readonly string[],
  ask: Ask
): FlowQuery[] {
  const out: FlowQuery[] = [];
  const pair = (measure: Measure, promql: string, more?: Partial<FlowQuery>) =>
    out.push(query(source, measure, promql, ISTIO_FROM, ISTIO_TO, more));
  if (found.includes("istio_requests_total")) {
    const metric = "istio_requests_total";
    const sides = (matchers: string[], tagged = false) =>
      bothSides(metric, matchers, ISTIO_CALL, ask, tagged);
    pair(
      "requests",
      sum([...ISTIO_PAIR, "request_protocol", SIDE], sides([], true)),
      { protocol: "request_protocol", side: SIDE }
    );
    pair(
      "errors",
      sum(
        ISTIO_PAIR,
        `${sides(['response_code=~"5.."'])} or ${sides([
          'request_protocol="grpc"',
          'grpc_response_status!="0"',
          'response_code!~"5.."',
        ])}`
      )
    );
    for (const [measure, q] of QUANTILES)
      pair(
        measure,
        `histogram_quantile(${q}, ${sum(
          ["le", ...ISTIO_PAIR],
          bothSides(
            "istio_request_duration_milliseconds_bucket",
            [],
            ["le", ...ISTIO_CALL],
            ask
          )
        )})`
      );
  }
  if (found.includes("istio_tcp_sent_bytes_total")) {
    // `rate` drops the name, so the two counters are told apart before they meet.
    const tagged = (metric: string, as: string, r: string) =>
      `label_replace(${scoped(metric, [r], ISTIO_SCOPE, ask)}, "rubick_way", "${as}", "", "")`;
    pair(
      "bytes",
      first(
        ...REPORTERS.map((r) =>
          sum(
            ISTIO_PAIR,
            `${tagged("istio_tcp_sent_bytes_total", "sent", r)} or ${tagged("istio_tcp_received_bytes_total", "received", r)}`
          )
        )
      )
    );
  }
  return out;
}

const HUBBLE_METRICS = [
  "hubble_flows_processed_total",
  "hubble_drop_total",
  "hubble_http_requests_total",
];
const HUBBLE_WORKLOAD = [
  "source_namespace",
  "source_workload",
  "source_workload_kind",
  "destination_namespace",
  "destination_workload",
  "destination_workload_kind",
];
const HUBBLE_POD = [
  "source_namespace",
  "source_pod",
  "destination_namespace",
  "destination_pod",
];
const HUBBLE_SCOPE = ["source_namespace", "destination_namespace"];
const hubbleEnd = (side: "source" | "destination") =>
  end({
    namespace: `${side}_namespace`,
    kind: `${side}_workload_kind`,
    name: `${side}_workload`,
    pod: `${side}_pod`,
  });

export function hubbleQueries(
  source: number,
  found: readonly string[],
  ask: Ask
): FlowQuery[] {
  const out: FlowQuery[] = [];
  const pairs = found.includes("source_workload")
    ? HUBBLE_WORKLOAD
    : HUBBLE_POD;
  const pair = (measure: Measure, promql: string, more?: Partial<FlowQuery>) =>
    out.push(
      query(
        source,
        measure,
        promql,
        hubbleEnd("source"),
        hubbleEnd("destination"),
        more
      )
    );
  if (found.includes("hubble_flows_processed_total")) {
    const forwarded = (direction: string) =>
      sum(
        pairs,
        scoped(
          "hubble_flows_processed_total",
          ['verdict="FORWARDED"', direction],
          HUBBLE_SCOPE,
          ask
        )
      );
    // Seen where it arrived before where it left, where the series say which.
    pair(
      "events",
      first(
        forwarded('traffic_direction!="egress"'),
        forwarded('traffic_direction="egress"')
      )
    );
  }
  if (found.includes("hubble_drop_total"))
    pair(
      "drops",
      sum(
        [...pairs, "reason"],
        scoped("hubble_drop_total", [], HUBBLE_SCOPE, ask)
      ),
      {
        reason: "reason",
      }
    );
  if (found.includes("hubble_http_requests_total")) {
    const reporters = ['reporter!="client"', 'reporter="client"'];
    const requests = reporters.map((r) =>
      sum(
        [...pairs, "protocol"],
        scoped("hubble_http_requests_total", [r], HUBBLE_SCOPE, ask)
      )
    );
    pair("requests", first(...requests), { protocol: "protocol" });
    pair(
      "errors",
      sameReporterAs(
        pairs,
        requests,
        reporters.map((r) =>
          sum(
            pairs,
            scoped(
              "hubble_http_requests_total",
              [r, 'status=~"5.."'],
              HUBBLE_SCOPE,
              ask
            )
          )
        )
      )
    );
    for (const [measure, q] of QUANTILES)
      pair(
        measure,
        first(
          ...reporters.map(
            (r) =>
              `histogram_quantile(${q}, ${sum(
                ["le", ...pairs],
                scoped(
                  "hubble_http_request_duration_seconds_bucket",
                  [r],
                  HUBBLE_SCOPE,
                  ask
                )
              )}) * 1000`
          )
        )
      );
  }
  return out;
}

const BEYLA_METRIC = '{__name__=~"(beyla|obi)_network_flow_bytes_total"}';
const BEYLA_PAIR = [
  "k8s_src_namespace",
  "k8s_src_owner_name",
  "k8s_src_owner_type",
  "k8s_dst_namespace",
  "k8s_dst_owner_name",
  "k8s_dst_owner_type",
];
const beylaEnd = (side: "src" | "dst") =>
  end({
    namespace: `k8s_${side}_namespace`,
    name: `k8s_${side}_owner_name`,
    kind: `k8s_${side}_owner_type`,
    kindAs: [
      { word: "Pod", is: "pod" },
      { word: "Node", is: "node" },
    ],
  });

export function beylaQueries(
  source: number,
  _found: readonly string[],
  ask: Ask
): FlowQuery[] {
  return [
    query(
      source,
      "bytes",
      sum(
        BEYLA_PAIR,
        scoped(
          BEYLA_METRIC,
          [],
          ["k8s_src_namespace", "k8s_dst_namespace"],
          ask
        )
      ),
      beylaEnd("src"),
      beylaEnd("dst")
    ),
  ];
}

const CARETTA_PAIR = [
  "client_namespace",
  "client_name",
  "client_kind",
  "server_namespace",
  "server_name",
  "server_kind",
];
const carettaEnd = (side: "client" | "server") =>
  end({
    namespace: `${side}_namespace`,
    name: `${side}_name`,
    kind: `${side}_kind`,
    kindAs: [
      { word: "pod", is: "pod" },
      { word: "node", is: "node" },
      { word: "Service", is: "service" },
      { word: "external", is: "address" },
    ],
  });

export function carettaQueries(
  source: number,
  _found: readonly string[],
  ask: Ask
): FlowQuery[] {
  // Each side's agent writes what its own socket sent, under the same
  // client and server labels (links_tracer.go): both roles added are both
  // directions, and a caller no agent runs beside is still seen by the server's.
  return [
    query(
      source,
      "bytes",
      sum(
        CARETTA_PAIR,
        scoped(
          "caretta_links_observed",
          [],
          ["client_namespace", "server_namespace"],
          ask
        )
      ),
      carettaEnd("client"),
      carettaEnd("server")
    ),
  ];
}

const namesOf = (series: { labels: Record<string, string> }[]) =>
  series
    .map((one) => one.labels["__name__"])
    .filter((name): name is string => Boolean(name));

const counted = (series: { points: { v: number | null }[] }[]) =>
  series.some((one) => (one.points[0]?.v ?? 0) > 0);

export const DEFINITIONS: readonly Definition[] = [
  {
    id: "istio",
    name: "Istio",
    need: "needIstio",
    marks: true,
    nodeAgent: false,
    grpcErrors: true,
    presence: [
      'count by (__name__) ({__name__=~"istio_requests_total|istio_tcp_sent_bytes_total"})',
    ],
    judge: ([names]) => {
      const http = names.includes("istio_requests_total");
      const tcp = names.includes("istio_tcp_sent_bytes_total");
      const measures: Measure[] = [
        ...(http ? (["requests", "errors", "p50", "p95", "p99"] as const) : []),
        ...(tcp ? (["bytes"] as const) : []),
      ];
      return {
        state: { says: http || tcp ? "present" : "absent" },
        measures,
        found: names,
        // Its workload label is a pod label, matched through the pods.
        needsPods: true,
      };
    },
    queries: istioQueries,
    marker: {
      containers: ["istio-proxy"],
      annotated: ["ambient.istio.io/redirection"],
    },
  },
  {
    id: "hubble",
    name: "Hubble",
    need: "needHubble",
    marks: false,
    nodeAgent: true,
    grpcErrors: false,
    presence: [
      `count by (__name__) ({__name__=~"${HUBBLE_METRICS.join("|")}"})`,
      `count({__name__=~"${HUBBLE_METRICS.join("|")}", destination_workload!=""})`,
      `count({__name__=~"${HUBBLE_METRICS.join("|")}", destination_pod!=""})`,
    ],
    judge: ([names, byWorkload, byPod]) => {
      const flows = names.includes("hubble_flows_processed_total");
      const drops = names.includes("hubble_drop_total");
      const http = names.includes("hubble_http_requests_total");
      const paired = byWorkload.length > 0 || byPod.length > 0;
      const measures: Measure[] = [
        ...(flows ? (["events"] as const) : []),
        ...(drops ? (["drops"] as const) : []),
        ...(http ? (["requests", "errors", "p50", "p95", "p99"] as const) : []),
      ];
      return {
        state: {
          says: names.length === 0 ? "absent" : paired ? "present" : "unpaired",
        },
        measures,
        found: [
          ...names,
          ...(byWorkload.length > 0
            ? ["source_workload"]
            : byPod.length > 0
              ? ["source_pod"]
              : []),
        ],
        needsPods: byWorkload.length === 0,
      };
    },
    queries: hubbleQueries,
  },
  {
    id: "beyla",
    name: "Beyla",
    need: "needBeyla",
    marks: false,
    nodeAgent: true,
    grpcErrors: false,
    presence: [`count by (__name__) (${BEYLA_METRIC})`],
    judge: ([names]) => ({
      state: { says: names.length > 0 ? "present" : "absent" },
      measures: ["bytes"],
      found: names,
      needsPods: false,
    }),
    queries: beylaQueries,
  },
  {
    id: "caretta",
    name: "Caretta",
    need: "needCaretta",
    marks: false,
    nodeAgent: true,
    grpcErrors: false,
    presence: ['count by (__name__) ({__name__="caretta_links_observed"})'],
    judge: ([names]) => ({
      state: { says: names.length > 0 ? "present" : "absent" },
      measures: ["bytes"],
      found: names,
      needsPods: false,
    }),
    queries: carettaQueries,
  },
];

/** Which sources this Prometheus holds series for: one to three counts each. */
export async function flowSources(): Promise<FlowSource[]> {
  return Promise.all(
    DEFINITIONS.map(async (definition) => {
      const base = {
        id: definition.id,
        name: definition.name,
        need: definition.need,
        marks: definition.marks,
        nodeAgent: definition.nodeAgent,
        grpcErrors: definition.grpcErrors,
      };
      try {
        const answers = await Promise.all(
          definition.presence.map((promql) => commands.prometheusQuery(promql))
        );
        // A bare `count(…)` answers one series whose value is the count; a
        // `count by (__name__)` one series a name.
        const found = answers.map((series, i) =>
          i === 0 ? namesOf(series) : counted(series) ? ["yes"] : []
        );
        return { ...base, ...definition.judge(found) };
      } catch (error) {
        return {
          ...base,
          state: { says: "failed", said: errorToShow(error) },
          measures: [],
          found: [],
          needsPods: false,
        } satisfies FlowSource;
      }
    })
  );
}

/** The present sources' flows, ends resolved in Rust, positionally as `sources`. */
export async function readFlows(input: {
  scope: string[] | null;
  window: FlowWindow;
  subject: WorkloadKey | null;
  sources: readonly FlowSource[];
}): Promise<TrafficReading> {
  const present = input.sources.filter(
    (source) => source.state.says === "present"
  );
  const ask = { scope: input.scope, window: input.window };
  const queries: FlowQuery[] = [];
  const markers: PodMarker[] = [];
  present.forEach((source, index) => {
    const definition = DEFINITIONS.find((each) => each.id === source.id);
    if (!definition) return;
    queries.push(...definition.queries(index, source.found, ask));
    if (definition.marker)
      markers.push({ source: index, ...definition.marker });
  });
  const answer = await commands.prometheusFlows(
    queries,
    input.scope,
    input.subject,
    markers
  );
  return { sources: present, answer, window: input.window };
}
