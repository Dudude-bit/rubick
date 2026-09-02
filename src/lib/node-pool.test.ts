import { describe, expect, it } from "vitest";

import type { NodeInfo } from "@/generated/types";
import {
  describePool,
  elideZonePrefix,
  nodePlacement,
  poolFacts,
  poolOf,
  spotMark,
  statesPlacement,
} from "./node-pool";

function node(
  labels: Record<string, string>,
  providerId: string | null = null
): NodeInfo {
  return {
    name: "n",
    uid: "u",
    status: { ready: true, conditions: [], addresses: [] },
    roles: [],
    version: "",
    os: "",
    arch: "",
    containerRuntime: "",
    labels,
    taints: [],
    unschedulable: false,
    capacity: { cpu: null, memory: null, pods: null, ephemeralStorage: null },
    allocatable: {
      cpu: null,
      memory: null,
      pods: null,
      ephemeralStorage: null,
    },
    providerId,
    createdAt: null,
  };
}

/** The standard three, which every managed offering sets the same way. */
const PLACE = {
  "node.kubernetes.io/instance-type": "e2-standard-4",
  "topology.kubernetes.io/region": "europe-west1",
  "topology.kubernetes.io/zone": "europe-west1-b",
};

/**
 * One row per way a real cluster spells the same four facts. Getting any key
 * or any value's case wrong here is invisible on a k3d cluster and shows up
 * as a Nodes page that stayed flat on the cluster it was built for, so the
 * spellings are pinned rather than exercised through one vendor.
 */
const VENDORS: [
  name: string,
  labels: Record<string, string>,
  providerId: string,
  pool: string,
  spot: boolean,
  cloud: string,
][] = [
  [
    "GKE, spot pool",
    {
      ...PLACE,
      "cloud.google.com/gke-nodepool": "batch",
      "cloud.google.com/gke-spot": "true",
    },
    "gce://prod-1234/europe-west1-b/gke-prod-batch-9f8e",
    "batch",
    true,
    "Google Cloud",
  ],
  [
    "GKE, older preemptible pool",
    {
      ...PLACE,
      "cloud.google.com/gke-nodepool": "batch",
      "cloud.google.com/gke-preemptible": "true",
    },
    "gce://prod-1234/europe-west1-b/gke-prod-batch-9f8e",
    "batch",
    true,
    "Google Cloud",
  ],
  [
    "GKE, the unified provisioning label",
    {
      ...PLACE,
      "cloud.google.com/gke-nodepool": "batch",
      "cloud.google.com/gke-provisioning": "spot",
    },
    "gce://prod-1234/europe-west1-b/gke-prod-batch-9f8e",
    "batch",
    true,
    "Google Cloud",
  ],
  [
    "EKS managed node group, on demand",
    {
      ...PLACE,
      "eks.amazonaws.com/nodegroup": "workers",
      "eks.amazonaws.com/capacityType": "ON_DEMAND",
    },
    "aws:///us-east-1a/i-0abc",
    "workers",
    false,
    "AWS",
  ],
  [
    // AWS shouts the value and Karpenter whispers it; both mean the same node.
    "EKS managed node group, SPOT in upper case",
    {
      ...PLACE,
      "eks.amazonaws.com/nodegroup": "workers",
      "eks.amazonaws.com/capacityType": "SPOT",
    },
    "aws:////i-0abc",
    "workers",
    true,
    "AWS",
  ],
  [
    "EKS with Karpenter, whose labels are not EKS's",
    {
      ...PLACE,
      "karpenter.sh/nodepool": "default",
      "karpenter.sh/capacity-type": "spot",
    },
    "aws:///us-east-1a/i-0abc",
    "default",
    true,
    "AWS",
  ],
  [
    // Karpenter v1 added a third value, and it is not spot.
    "EKS with Karpenter on reserved capacity",
    {
      ...PLACE,
      "karpenter.sh/nodepool": "default",
      "karpenter.sh/capacity-type": "reserved",
    },
    "aws:///us-east-1a/i-0abc",
    "default",
    false,
    "AWS",
  ],
  [
    "AKS, current priority label",
    {
      ...PLACE,
      "kubernetes.azure.com/agentpool": "userpool",
      "kubernetes.azure.com/priority": "spot",
    },
    "azure:///subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/x",
    "userpool",
    true,
    "Azure",
  ],
  [
    "AKS, deprecated scalesetpriority label",
    {
      ...PLACE,
      "kubernetes.azure.com/agentpool": "userpool",
      "kubernetes.azure.com/scalesetpriority": "spot",
    },
    "azure:///subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/x",
    "userpool",
    true,
    "Azure",
  ],
];

describe("nodePlacement", () => {
  it.each(VENDORS)(
    "reads %s",
    (_name, labels, providerId, pool, spot, cloud) => {
      const placement = nodePlacement(node(labels, providerId));
      expect(placement.pool).toBe(pool);
      expect(placement.spot).toBe(spot);
      expect(placement.cloud).toBe(cloud);
      expect(placement.machine).toBe("e2-standard-4");
      expect(placement.zone).toBe("europe-west1-b");
      expect(placement.region).toBe("europe-west1");
    }
  );

  /**
   * The case every reader on a laptop sees. If this starts returning
   * anything, k3d, kind and minikube grow a section, a column or a caption
   * that states a fact nobody told us.
   */
  it("claims nothing about a cluster that says nothing", () => {
    const placement = nodePlacement(
      node({ "node-role.kubernetes.io/master": "true" })
    );
    expect(placement).toEqual({
      pool: null,
      machine: null,
      zone: null,
      region: null,
      spot: false,
      cloud: null,
      providerId: null,
    });
    expect(statesPlacement(placement)).toBe(false);
    expect(poolOf(node({}))).toBe(null);
  });

  /**
   * k3s writes `k3s://<node-name>` on every node it makes, so a providerID on
   * its own is not evidence of a cloud and must not open a section: the k3d
   * page has to stay byte-for-byte what it was.
   */
  it("does not turn an unrecognised providerID into a cloud", () => {
    const placement = nodePlacement(node({}, "k3s://k3d-dev-server-0"));
    expect(placement.cloud).toBe(null);
    expect(placement.providerId).toBe("k3s://k3d-dev-server-0");
    expect(statesPlacement(placement)).toBe(false);
  });

  /** Azure disagrees with itself about the case of its own providerID. */
  it("reads a cloud whatever case the scheme arrives in", () => {
    expect(nodePlacement(node({}, "AZURE:///subscriptions/abc")).cloud).toBe(
      "Azure"
    );
  });

  /**
   * A node that is placed but unpooled — a self-managed VM beside a managed
   * group — still has facts worth a section; it just has no pool to group by.
   */
  it("states a placement with no pool label", () => {
    const placement = nodePlacement(node(PLACE, "gce://p/z/i"));
    expect(placement.pool).toBe(null);
    expect(statesPlacement(placement)).toBe(true);
  });
});

describe("a pool whose nodes disagree", () => {
  const inZone = (zone: string, machine = "e2-standard-4", spot = false) =>
    node({
      "cloud.google.com/gke-nodepool": "default-pool",
      "node.kubernetes.io/instance-type": machine,
      "topology.kubernetes.io/zone": zone,
      ...(spot ? { "cloud.google.com/gke-spot": "true" } : {}),
    });

  /**
   * The header used to be free to take the first node's zone and call it the
   * pool's, which is wrong for every regional pool there is.
   */
  it("names every zone the pool spans, not the first one", () => {
    const facts = poolFacts([
      inZone("europe-west1-b"),
      inZone("europe-west1-c"),
    ]);
    expect(facts.zones).toEqual(["europe-west1-b", "europe-west1-c"]);
    expect(describePool(facts)).toBe(
      "e2-standard-4 · europe-west1-b, -c · 2 nodes"
    );
  });

  /** EKS lets one node group hold several instance types. */
  it("names every machine type in the pool", () => {
    const facts = poolFacts([
      inZone("us-east-1a", "m5.large"),
      inZone("us-east-1a", "m5.xlarge"),
    ]);
    expect(describePool(facts)).toBe(
      "m5.large, m5.xlarge · us-east-1a · 2 nodes"
    );
  });

  /** Past three, naming them turns the caption into a wall. */
  it("counts rather than lists once a facet is a list", () => {
    const facts = poolFacts(
      ["m5.large", "m5.xlarge", "m5.2xlarge", "c6i.large"].map((machine) =>
        inZone("us-east-1a", machine)
      )
    );
    expect(describePool(facts)).toBe("4 machine types · us-east-1a · 4 nodes");
  });

  /**
   * A pool where two of five nodes can vanish is not the arrangement a pool
   * where all five can is, and saying "spot" for both would be picking one
   * node's truth and calling it the pool's.
   */
  it("counts the spot nodes when only some of them are spot", () => {
    expect(
      spotMark(poolFacts([inZone("a", "m", true), inZone("a", "m", false)]))
    ).toBe("1 of 2 spot");
    expect(
      spotMark(poolFacts([inZone("a", "m", true), inZone("a", "m", true)]))
    ).toBe("spot");
  });

  /** No label saying spot is not the same as a label saying on demand. */
  it("marks nothing when nothing said spot", () => {
    expect(spotMark(poolFacts([inZone("a")]))).toBe(null);
  });

  /** A pool that only names itself still says how big it is. */
  it("drops the facets the cluster did not state", () => {
    const bare = node({ "eks.amazonaws.com/nodegroup": "workers" });
    expect(describePool(poolFacts([bare]))).toBe("1 node");
  });
});

describe("elideZonePrefix", () => {
  /** `europe-west1-b, europe-west1-c` is one string written twice. */
  it("elides the region the zones share", () => {
    expect(elideZonePrefix(["europe-west1-b", "europe-west1-c"])).toEqual([
      "europe-west1-b",
      "-c",
    ]);
  });

  /** Two regions in one list must not collapse into a line hiding which. */
  it("leaves zones of different regions written out", () => {
    expect(elideZonePrefix(["europe-west1-b", "us-east1-a"])).toEqual([
      "europe-west1-b",
      "us-east1-a",
    ]);
  });

  it("leaves a single zone and a zone with no separator alone", () => {
    expect(elideZonePrefix(["europe-west1-b"])).toEqual(["europe-west1-b"]);
    expect(elideZonePrefix(["nova", "nova2"])).toEqual(["nova", "nova2"]);
  });
});
