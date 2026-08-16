import { describe, expect, it } from "vitest";

import { resolveSource, type PeekSummary } from "./peek-sources";
import type { NodeInfo } from "@/generated/types";
import type { PeekTarget } from "@/hooks/usePeek";

function node(labels: Record<string, string> = {}): NodeInfo {
  return {
    name: "k3d-k8s-gui-dev-agent-0",
    uid: "node-uid",
    status: { ready: true, conditions: [], addresses: [] },
    roles: [],
    version: "v1.31.5+k3s1",
    os: "linux",
    arch: "amd64",
    containerRuntime: "containerd://2.0.0",
    labels,
    taints: [],
    capacity: { cpu: "8", memory: "16Gi", pods: "110", ephemeralStorage: null },
    allocatable: {
      cpu: "8",
      memory: "16Gi",
      pods: "110",
      ephemeralStorage: null,
    },
    providerId: "k3s://k3d-k8s-gui-dev-agent-0",
    createdAt: null,
  };
}

const target: PeekTarget = { kind: "Node", name: "k3d-k8s-gui-dev-agent-0" };

const summarise = (labels: Record<string, string> = {}): PeekSummary =>
  resolveSource(target).summarise(node(labels), target);

const group = (summary: PeekSummary, title: string) =>
  summary.groups.find((entry) => entry.title === title);

const rows = (summary: PeekSummary, title: string) =>
  (group(summary, title)?.items ?? []).map((item) => [item.label, item.value]);

describe("the node a peek opens on", () => {
  it("says which pool made it, what it is and where, when the cluster says", () => {
    const summary = summarise({
      "cloud.google.com/gke-nodepool": "batch-pool",
      "node.kubernetes.io/instance-type": "e2-standard-4",
      "topology.kubernetes.io/zone": "europe-west1-b",
    });
    expect(rows(summary, "Placement")).toEqual(
      expect.arrayContaining([
        ["Pool", "batch-pool"],
        ["Instance type", "e2-standard-4"],
        ["Zone", "europe-west1-b"],
      ])
    );
  });

  it("marks a node the cloud can take back, in the colour of a warning", () => {
    const summary = summarise({
      "cloud.google.com/gke-nodepool": "batch-pool",
      "cloud.google.com/gke-spot": "true",
    });
    const spot = group(summary, "Placement")?.items.find(
      (item) => item.label === "Spot"
    );
    expect(spot?.tone).toBe("warn");
    expect(String(spot?.value)).toMatch(/take this node back/i);
  });

  it("claims nothing about a node no vendor labelled", () => {
    // A k3d node carries a providerID and nothing else. "Not spot" is not a
    // fact anybody holds, so the panel is the one it was before this existed.
    const summary = summarise();
    expect(group(summary, "Placement")).toBeUndefined();
    expect(group(summary, "Machine")).toBeDefined();
    expect(JSON.stringify(summary)).not.toMatch(/spot/i);
  });
});
