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
