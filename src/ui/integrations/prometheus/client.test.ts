import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PromSeries } from "@/generated/types";

const prometheusQueryRange = vi.fn<(query: string) => Promise<PromSeries[]>>();
const prometheusQuery = vi.fn<(query: string) => Promise<PromSeries[]>>();

vi.mock("@/lib/commands", () => ({
  commands: {
    prometheusQueryRange: (query: string) => prometheusQueryRange(query),
    prometheusQuery: (query: string) => prometheusQuery(query),
  },
}));

const { nodeUsage, usageHistory } = await import("./client");

const points = (values: number[]): PromSeries[] => [
  {
    labels: {},
    points: values.map((v, i) => ({ t: 1_700_000_000_000 + i * 30_000, v })),
  },
];

beforeEach(() => {
  prometheusQueryRange.mockReset();
  prometheusQuery.mockReset();
});

describe("usageHistory and what was declared", () => {
  const scope = { kind: "pod" as const, namespace: "shop", pod: "payments-0" };

  /** An empty declared series is two different worlds: nothing declared, or nobody recording. The chart has to be told which. */
  it("says the record is missing when kube-state-metrics is absent", async () => {
    prometheusQueryRange.mockImplementation(async (query) =>
      query.includes("kube_pod_container_resource") ? [] : points([40, 41])
    );
    prometheusQuery.mockResolvedValue([]);

    const window = await usageHistory({ scope, range: "1h" });
    expect(window.samples).toHaveLength(2);
    expect(window.declared).toBeNull();
  });

  it("keeps an empty declared line when kube-state-metrics is there and the pod asks for nothing", async () => {
    prometheusQueryRange.mockImplementation(async (query) =>
      query.includes("kube_pod_container_resource") ? [] : points([40])
    );
    prometheusQuery.mockResolvedValue([
      { labels: {}, points: [{ t: 0, v: 812 }] },
    ]);

    const window = await usageHistory({ scope, range: "1h" });
    expect(window.declared).toEqual({
      cpuRequest: [],
      cpuLimit: [],
      memoryRequest: [],
      memoryLimit: [],
    });
  });

  it("carries the declared series through in the chart's units", async () => {
    prometheusQueryRange.mockImplementation(async (query) =>
      query.includes('resource_requests{resource="cpu"')
        ? points([250, 250])
        : query.includes("kube_pod_container_resource")
          ? []
          : points([40, 41])
    );

    const window = await usageHistory({ scope, range: "1h" });
    expect(window.declared?.cpuRequest.map((p) => p.v)).toEqual([250, 250]);
    // Present as a family, so the empty lines are "nothing declared".
    expect(window.declared?.memoryLimit).toEqual([]);
    expect(prometheusQuery).not.toHaveBeenCalled();
  });
});

describe("nodeUsage", () => {
  /** A node whose series carries `instance` instead of `node` is the same node. */
  it("keys each node by whichever label the supplier wrote, and says when it last spoke", async () => {
    prometheusQueryRange.mockImplementation(async (query) => [
      {
        labels: (query.includes("cpu")
          ? { node: "n1" }
          : { instance: "n1:10250" }) as Record<string, string>,
        points: [
          { t: 1_700_000_000_000, v: query.includes("cpu") ? 900 : 5e9 },
        ],
      },
    ]);
    prometheusQuery.mockResolvedValue([
      { labels: { node: "n1" }, points: [{ t: 0, v: 1_700_000_000 }] },
    ]);

    const window = await nodeUsage({ range: "6h" });
    expect(Object.keys(window.nodes)).toEqual(["n1"]);
    expect(window.nodes.n1.cpuMillicores[0].v).toBe(900);
    expect(window.nodes.n1.memoryBytes[0].v).toBe(5e9);
    expect(window.newestAt.n1).toBe(1_700_000_000_000);
  });
});

describe("a read that failed is not an answer", () => {
  const scope = { kind: "pod" as const, namespace: "shop", pod: "payments-0" };

  /**
   * A refused or rate-limited probe used to read as "absent", and the chart
   * then stated as fact that kube-state-metrics is not in this Prometheus.
   * Fails if the probe's failure is folded back into `false`.
   */
  it("does not call kube-state-metrics absent when the probe itself failed", async () => {
    prometheusQueryRange.mockImplementation(async (query) =>
      query.includes("kube_pod_container_resource") ? [] : points([40, 41])
    );
    prometheusQuery.mockRejectedValue(new Error("429 Too Many Requests"));

    const window = await usageHistory({ scope, range: "1h" });
    expect(window.declared).toBeNull();
    expect(window.declaredKnown).toBe(false);
  });

  /** A swallowed declared range left a sibling series standing, which made the whole record look answered. */
  it("marks the record unknown when a declared range query failed", async () => {
    prometheusQueryRange.mockImplementation(async (query) => {
      if (!query.includes("kube_pod_container_resource")) return points([40]);
      if (query.includes("limits")) throw new Error("400 too many samples");
      return points([100]);
    });
    prometheusQuery.mockResolvedValue(points([1]));

    const window = await usageHistory({ scope, range: "1h" });
    expect(window.declaredKnown).toBe(false);
  });

  /** An empty `newestAt` used to read as "Prometheus never had a series for this node". */
  it("marks node staleness unknown when the staleness probe failed", async () => {
    prometheusQueryRange.mockResolvedValue(points([10]));
    prometheusQuery.mockRejectedValue(new Error("403 Forbidden"));

    const window = await nodeUsage({ range: "1h" });
    expect(window.newestKnown).toBe(false);
    expect(window.newestAt).toEqual({});
  });

  /** A dropped bucket closes the line up and an outage is drawn straight across it. */
  it("keeps a bucket the supplier had nothing for as a gap", async () => {
    prometheusQueryRange.mockResolvedValue([
      {
        labels: { node: "worker-1" },
        points: [
          { t: 1, v: 5 },
          { t: 2, v: null },
          { t: 3, v: 7 },
        ],
      } as unknown as PromSeries,
    ]);
    prometheusQuery.mockResolvedValue([]);

    const window = await nodeUsage({ range: "1h" });
    expect(window.nodes["worker-1"].cpuMillicores).toEqual([
      { t: 1, v: 5 },
      { t: 2, v: null },
      { t: 3, v: 7 },
    ]);
  });
});

describe("a node's basis", () => {
  const ROOT = 'id="/"';
  const PODS = 'pod!=""';
  const series = (labels: Record<string, string>, v: number): PromSeries[] => [
    { labels, points: [{ t: 1_700_000_000_000, v }] },
  ];

  /**
   * kube-prometheus-stack drops every cgroup series without a pod, so the
   * root cgroup never exists there. Fails if the pods fallback is deleted:
   * every node would then read "no series" on the most common install.
   */
  it("reads every node from its pods when no node has a root cgroup series", async () => {
    prometheusQueryRange.mockImplementation(async (query) =>
      query.includes(ROOT)
        ? []
        : series({ node: "n1" }, query.includes("cpu") ? 700 : 3e9)
    );
    prometheusQuery.mockResolvedValue([]);

    const window = await nodeUsage({ range: "6h" });
    expect(window.basis).toBe("pods");
    expect(window.nodes.n1.cpuMillicores[0].v).toBe(700);
    expect(window.nodes.n1.memoryBytes[0].v).toBe(3e9);
    expect(prometheusQuery.mock.calls.at(-1)?.[0]).toContain(PODS);
  });

  /** One basis for the whole window: a sum of pods is never mixed with whole-node figures. */
  it("keeps the root cgroup and asks nothing of the pods when any node has it", async () => {
    prometheusQueryRange.mockImplementation(async (query) =>
      query.includes(ROOT) ? series({ node: "n1" }, 900) : []
    );
    prometheusQuery.mockResolvedValue([]);

    const window = await nodeUsage({ range: "6h" });
    expect(window.basis).toBe("node");
    expect(
      prometheusQueryRange.mock.calls.some(([query]) => query.includes(PODS))
    ).toBe(false);
  });

  /**
   * A refused fallback read is "could not look", never "no series". Fails if
   * the pods read is swallowed into an empty window.
   */
  it("rejects when the pods read is refused, rather than reporting silence", async () => {
    prometheusQueryRange.mockImplementation(async (query) => {
      if (query.includes(ROOT)) return [];
      throw new Error("403 Forbidden");
    });
    prometheusQuery.mockResolvedValue([]);

    await expect(nodeUsage({ range: "6h" })).rejects.toThrow("403");
  });

  describe("on the node detail page", () => {
    const scope = { kind: "node" as const, node: "n1" };
    const usage = (query: string) =>
      query.includes("container_cpu_usage_seconds_total") ||
      query.includes("container_memory_working_set_bytes");

    /**
     * The list and the page read the same fact. Fails if the page keeps the
     * root cgroup where the list fell back, and draws an empty chart beside
     * a list that has numbers for the same node.
     */
    it("falls back to the pods where the list would", async () => {
      prometheusQueryRange.mockImplementation(async (query) =>
        usage(query) && !query.includes(ROOT) ? points([500, 600]) : []
      );
      prometheusQuery.mockImplementation(async (query) =>
        query.includes("last_over_time") ? [] : points([1])
      );

      const window = await usageHistory({ scope, range: "1h" });
      expect(window.basis).toBe("pods");
      expect(window.samples.map((s) => s.cpuMillicores)).toEqual([500, 600]);
    });

    /** The list's rule is cluster-wide: another node with a root cgroup makes this one a node with no series. */
    it("keeps the root cgroup when another node reports on it", async () => {
      prometheusQueryRange.mockResolvedValue([]);
      prometheusQuery.mockImplementation(async (query) =>
        query.includes("last_over_time") ? points([3]) : points([1])
      );

      const window = await usageHistory({ scope, range: "1h" });
      expect(window.basis).toBe("node");
      expect(window.samples).toEqual([]);
    });

    /** A refused probe cannot decide the basis, and an empty chart would claim it had. */
    it("rejects when the basis probe is refused", async () => {
      prometheusQueryRange.mockResolvedValue([]);
      prometheusQuery.mockImplementation(async (query) => {
        if (query.includes("last_over_time")) throw new Error("403 Forbidden");
        return points([1]);
      });

      await expect(usageHistory({ scope, range: "1h" })).rejects.toThrow("403");
    });

    /** Pod and workload windows carry no basis: the note is about nodes only. */
    it("leaves the basis off a pod's window", async () => {
      prometheusQueryRange.mockResolvedValue(points([1]));
      prometheusQuery.mockResolvedValue(points([1]));
      const window = await usageHistory({
        scope: { kind: "pod", namespace: "shop", pod: "payments-0" },
        range: "1h",
      });
      expect(window.basis).toBeUndefined();
    });
  });
});
