import { describe, expect, it } from "vitest";

import type { NodeUsageWindow } from "@/integrations";
import type { NodeInfo } from "@/generated/types";
import { nodeTrends } from "./node-trends";

function node(name: string, unschedulable = false): NodeInfo {
  return {
    name,
    uid: name,
    status: { ready: true, conditions: [], addresses: [] },
    roles: [],
    version: "v1.32.0",
    os: "linux",
    arch: "arm64",
    containerRuntime: "containerd://1.7",
    labels: {},
    taints: [],
    unschedulable,
    capacity: { cpu: "4", memory: "16Gi", pods: "110", ephemeralStorage: null },
    allocatable: {
      cpu: "4",
      memory: "16Gi",
      pods: "110",
      ephemeralStorage: null,
    },
    providerId: null,
    createdAt: null,
  };
}

const GI = 1024 ** 3;
const T0 = 1_700_000_000_000;

const window: NodeUsageWindow = {
  nodes: {
    // Full name against the cluster's short one: the same node.
    "ip-10-0-1-1.eu-central-1.compute.internal": {
      cpuMillicores: [
        { t: T0, v: 1000 },
        { t: T0 + 60_000, v: 3600 },
      ],
      memoryBytes: [
        { t: T0, v: 4 * GI },
        { t: T0 + 60_000, v: 8 * GI },
      ],
    },
    "ip-10-0-1-2": {
      cpuMillicores: [{ t: T0, v: 400 }],
      memoryBytes: [{ t: T0, v: 2 * GI }],
    },
  },
  newestAt: { "ip-10-0-1-3": T0 - 4 * 60_000 },
  resolution: "30s buckets",
};

describe("nodeTrends", () => {
  /** A hot node at the bottom of the list is the list failing at its one job. */
  it("puts the least headroom first and reads the peak as a share of allocatable", () => {
    const trends = nodeTrends(
      window,
      [node("ip-10-0-1-2"), node("ip-10-0-1-1")],
      T0 + 120_000
    );
    expect(trends.map((t) => t.node.name)).toEqual([
      "ip-10-0-1-1",
      "ip-10-0-1-2",
    ]);
    expect(trends[0].cpu?.peak).toBeCloseTo(90);
    expect(trends[0].cpu?.avg).toBeCloseTo(57.5);
    expect(trends[0].memory?.peak).toBeCloseTo(50);
    expect(trends[0].headroom).toBeCloseTo(10);
  });

  /** A node with no series drawn at zero reads as an idle node, which is the opposite of unknown. */
  it("says nothing for a node without a series, and sorts it last", () => {
    const trends = nodeTrends(
      window,
      [node("ip-10-0-1-3"), node("ip-10-0-1-1")],
      T0 + 120_000
    );
    const silent = trends[1];
    expect(silent.node.name).toBe("ip-10-0-1-3");
    expect(silent.cpu).toBeNull();
    expect(silent.memory).toBeNull();
    expect(silent.headroom).toBeNull();
    expect(silent.newestAgoMs).toBe(6 * 60_000);
  });

  it("carries the cordon so the row can say the number is a decision, not a fault", () => {
    const [only] = nodeTrends(window, [node("ip-10-0-1-2", true)], T0);
    expect(only.cordoned).toBe(true);
  });

  it("has nothing to say without a window", () => {
    const trends = nodeTrends(null, [node("a"), node("b")], T0);
    expect(trends.every((t) => t.cpu === null && t.newestAgoMs === null)).toBe(
      true
    );
    expect(trends.map((t) => t.node.name)).toEqual(["a", "b"]);
  });
});
