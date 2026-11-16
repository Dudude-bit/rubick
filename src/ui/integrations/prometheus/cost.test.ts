import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PromSeries, WorkloadFold } from "@/generated/types";

const prometheusQuery = vi.fn<(query: string) => Promise<PromSeries[]>>();
const prometheusByWorkload = vi.fn<() => Promise<WorkloadFold>>();
const prometheusQueryRange = vi.fn<() => Promise<PromSeries[]>>();

vi.mock("@/lib/commands", () => ({
  commands: {
    prometheusQuery: (query: string) => prometheusQuery(query),
    prometheusByWorkload: () => prometheusByWorkload(),
    prometheusQueryRange: () => prometheusQueryRange(),
  },
}));

const {
  NODES_QUERY,
  PRESENCE_QUERY,
  TOTALS_QUERY,
  allocationCost,
  costNow,
  estimateTrendQuery,
  inNamespaces,
  own,
  usageQueries,
  withHoles,
  workloadQueries,
} = await import("./cost");

const one = (labels: Record<string, string>, v: number | null): PromSeries => ({
  labels,
  points: [{ t: 0, v }],
});

const FOLD: WorkloadFold = {
  values: [],
  rest: [null, null, null, null],
  unplaced: [],
  unread: [],
  unlabelled: 0,
  since: [],
};

beforeEach(() => {
  prometheusQuery.mockReset();
  prometheusQuery.mockResolvedValue([]);
  prometheusByWorkload.mockReset();
  prometheusByWorkload.mockResolvedValue(FOLD);
});

describe("the cost PromQL", () => {
  /**
   * Scraped without honor_labels, the metric's namespace, pod and node
   * arrive as exported_*; read under their own names only, every join
   * would come back empty and the page would say there are no series.
   */
  it("reads namespace, pod and node back from their exported_ names", () => {
    const expression = own("container_cpu_allocation");
    for (const label of ["namespace", "pod", "node"])
      expect(expression).toContain(
        `"${label}", "$1", "exported_${label}", "(.+)"`
      );
  });

  /** A namespace filter must match either spelling, or a renamed scrape reads as none. */
  it("narrows to the scope under either label the namespace arrived as", () => {
    const expression = inNamespaces("pod_pvc_allocation", ["shop", "a.b"]);
    expect(expression).toContain('exported_namespace=~"^(shop|a\\\\.b)$"');
    expect(expression).toContain(
      'exported_namespace="",namespace=~"^(shop|a\\\\.b)$"'
    );
  });

  /** A cost model scraped by two jobs answers twice; the join must not double it. */
  it("takes each container once before pricing it at its node's rate", () => {
    expect(allocationCost("memory", null)).toMatch(
      /^max by \(namespace, pod, container, node\) \(.+\) \/ 1073741824 \* on \(node\) group_left \(\) max by \(node\) \(.*node_ram_hourly_cost.*\)$/
    );
  });

  it("asks each workload part per pod, in the order the picture reads them", () => {
    const queries = workloadQueries(["shop"]);
    expect(queries).toHaveLength(4);
    for (const query of queries)
      expect(query).toMatch(/^sum by \(namespace, pod\)/);
    expect(queries[0]).toContain("node_cpu_hourly_cost");
    expect(queries[3]).toContain("pod_pvc_allocation");
  });

  /**
   * Each average runs over the samples a pod has, summed over its
   * containers at each step: `rate(x[24h])` divided two hours of a fresh
   * pod by a day, and averaging each container series before summing
   * counted a restarted container once per restart. Fails if either
   * average came back to the whole-window or per-series form.
   */
  it("averages use over each pod's own samples, its containers summed first", () => {
    const [cpuAvg, cpuPeak, memoryAvg, memoryPeak] = usageQueries(null);
    const summed = "avg_over_time((sum by (namespace, pod) (";
    expect(cpuAvg.startsWith(summed)).toBe(true);
    expect(cpuAvg).toContain("[5m])))[24h:5m])");
    expect(memoryAvg.startsWith(summed)).toBe(true);
    expect(memoryAvg).toContain("))[24h:5m])");
    expect(cpuPeak).toContain("[24h:5m]");
    expect(memoryPeak).toContain("max_over_time");
  });

  /** An unentered price leaves its resource out of the trend rather than at zero. */
  it("draws an estimate's trend only from the prices entered", () => {
    const query = estimateTrendQuery(null, {
      cpu: 0.04,
      memory: 0.005,
      storage: null,
      gpu: null,
      currency: "",
    });
    expect(query).toContain("kube_node_status_capacity");
    expect(query).toContain("* 0.04");
    expect(query).not.toContain("kube_persistentvolume_capacity_bytes");
    expect(query).not.toContain("_gpu");
  });
});

describe("what the cluster costs now", () => {
  /**
   * A Prometheus that answered and holds none of the series by name is
   * "no series", which the page says with a way forward: not an error, and
   * not a cluster that costs nothing.
   */
  it("is no answer where Prometheus holds none of the cost series", async () => {
    const answer = await costNow({ namespaces: null, keys: [], nodes: true });
    expect(answer).toBeNull();
    expect(prometheusQuery).toHaveBeenCalledWith(PRESENCE_QUERY);
  });

  /** Series present without node prices is a reading with every node unpriced, not "none". */
  it("is a reading, not none, where the series are there and node prices are not", async () => {
    prometheusQuery.mockImplementation(async (query) =>
      query === PRESENCE_QUERY
        ? [one({ __name__: "container_cpu_allocation" }, 3)]
        : []
    );
    const answer = await costNow({ namespaces: null, keys: [], nodes: true });
    expect(answer).not.toBeNull();
    expect(answer!.nodes).toEqual([]);
  });

  it("fails, never empties, when Prometheus does not answer", async () => {
    prometheusQuery.mockRejectedValue(new Error("connection refused"));
    await expect(
      costNow({ namespaces: null, keys: [], nodes: true })
    ).rejects.toThrow("connection refused");
  });

  /** A price series with no node label prices nothing nameable, and the page says which label. */
  it("names the label the node prices are missing", async () => {
    prometheusQuery.mockImplementation(async (query) =>
      query === NODES_QUERY ? [one({ instance_type: "m5" }, 0.2)] : []
    );
    const answer = await costNow({ namespaces: null, keys: [], nodes: true });
    expect(answer!.missingLabels).toContain("node");
    expect(answer!.nodes).toEqual([]);
  });

  /** The heaviest read timing out must not take the totals down with it. */
  it("keeps the totals when the per-workload read fails", async () => {
    prometheusQuery.mockImplementation(async (query) =>
      query === NODES_QUERY ? [one({ node: "node-a" }, 0.2)] : []
    );
    prometheusByWorkload.mockRejectedValue(new Error("timed out after 20s"));
    const answer = await costNow({ namespaces: null, keys: [], nodes: true });
    expect(answer!.nodes[0]!.perHour).toBe(0.2);
    expect(answer!.workloads).toEqual({ failed: "timed out after 20s" });
  });

  /**
   * Where no volume carries a price, listing every volume as unpriced
   * would bury the one sentence that matters: storage has no price here.
   */
  it("does not list every volume as unpriced when none is priced", async () => {
    prometheusQuery.mockImplementation(async (query) =>
      query === NODES_QUERY
        ? [one({ node: "node-a" }, 0.2)]
        : query === TOTALS_QUERY
          ? [one({ part: "pricedVolumes" }, 0)]
          : query.startsWith(
                "label_replace(max by (persistentvolume) (kube_persistentvolume_capacity_bytes)"
              )
            ? [one({ persistentvolume: "pv-1", why: "unpriced" }, 1)]
            : []
    );
    const answer = await costNow({ namespaces: null, keys: [], nodes: true });
    expect(answer!.storage.priced).toBe(false);
    expect(answer!.storage.unpriced).toEqual([]);
  });
});

describe("a trend with holes", () => {
  /** A step Prometheus had no sample for is left out of its answer; drawn joined, the hole would vanish. */
  it("puts back every step Prometheus left out, empty", () => {
    const points = withHoles(
      [
        { t: 1000, v: 1 },
        { t: 4000, v: 2 },
      ],
      1000,
      4000,
      1000
    );
    expect(points).toEqual([
      { t: 1000, v: 1 },
      { t: 2000, v: null },
      { t: 3000, v: null },
      { t: 4000, v: 2 },
    ]);
  });
});
