import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeploymentInfo } from "@/generated/types";

const listDeployments = vi.fn();
const checkAccess = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    listDeployments: (...a: unknown[]) => listDeployments(...a),
    checkAccess: (...a: unknown[]) => checkAccess(...a),
    listCustomResources: vi.fn(),
  },
}));
vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: () => "kind-test",
}));

const lastQueryFn: { current: (() => Promise<unknown>) | null } = {
  current: null,
};
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryFn: () => Promise<unknown> }) => {
    lastQueryFn.current = opts.queryFn;
    return {};
  },
}));
vi.mock("@/hooks/useLiveQuery", () => ({ useLiveQuery: () => ({}) }));

const { useOperator } = await import("./data");

function useOperatorRead(ns: readonly string[] = []): () => Promise<unknown> {
  useOperator(ns);
  const fn = lastQueryFn.current;
  if (!fn) throw new Error("useOperator registered no queryFn");
  return fn;
}

const deployment = (image: string): DeploymentInfo =>
  ({
    name: "scylla-operator",
    namespace: "scylla-operator",
    replicas: { ready: 1, desired: 1 },
    containers: [{ image }],
  }) as unknown as DeploymentInfo;

beforeEach(() => vi.clearAllMocks());

describe("useOperator", () => {
  /**
   * A reader who may see the Scylla CRs but not the cluster's Deployments is
   * an ordinary namespace-scoped RBAC user. Their refused list became `[]`,
   * and the page then said no scylla-operator Deployment exists and that
   * ScyllaDB Manager is not installed — about reads nobody got.
   */
  it("says whether the operator is running is unknown when the read was refused", async () => {
    listDeployments.mockRejectedValue(new Error("deployments is forbidden"));
    checkAccess.mockResolvedValue([{ allowed: true }]);
    const info = (await useOperatorRead()()) as {
      operator: unknown;
      operatorKnown: boolean;
      operatorReason: string | null;
      managerKnown: boolean;
    };
    expect(info.operatorKnown).toBe(false);
    expect(info.managerKnown).toBe(false);
    expect(info.operator).toBeNull();
    expect(info.operatorReason).toMatch(/forbidden/);
  });

  /** A read that succeeded and found nothing is the other answer, and stays it. */
  it("says the operator is absent only on a read that found nothing", async () => {
    listDeployments.mockResolvedValue([]);
    checkAccess.mockResolvedValue([{ allowed: true }]);
    const info = (await useOperatorRead()()) as {
      operatorKnown: boolean;
      operator: unknown;
    };
    expect(info.operatorKnown).toBe(true);
    expect(info.operator).toBeNull();
  });

  /**
   * A registry may carry a port. Splitting the whole reference on ":" then
   * returned the port, so `registry.internal:5000/scylla-operator` reported
   * the operator's version as "5000".
   */
  it("reads the version off the tag and not off a registry port", async () => {
    checkAccess.mockResolvedValue([{ allowed: true }]);
    listDeployments.mockResolvedValue([
      deployment("docker.io/scylladb/scylla-operator:1.22.0"),
    ]);
    const tagged = (await useOperatorRead()()) as { version: string | null };
    expect(tagged.version).toBe("1.22.0");

    listDeployments.mockResolvedValue([
      deployment("registry.internal:5000/scylla-operator"),
    ]);
    const ported = (await useOperatorRead()()) as { version: string | null };
    expect(ported.version).toBeNull();

    listDeployments.mockResolvedValue([
      deployment("registry.internal:5000/scylla-operator:v1.19.2"),
    ]);
    const both = (await useOperatorRead()()) as { version: string | null };
    expect(both.version).toBe("1.19.2");
  });

  /**
   * Asked with no namespace, the review means "in every namespace", which a
   * namespace-scoped grant answers no to — and every knob on the reader's
   * own cluster came up disabled saying the cluster refuses it.
   */
  it("asks the patch verb in each namespace a cluster was found in", async () => {
    listDeployments.mockResolvedValue([]);
    checkAccess.mockResolvedValue([
      { allowed: false },
      { allowed: true },
      { allowed: false },
    ]);
    const info = (await useOperatorRead(["shop", "billing"])()) as {
      canPatchClusters: boolean | null;
      patchIn: Map<string | null, boolean | null>;
    };
    const asked = checkAccess.mock.lastCall?.[0] as {
      namespace: string | null;
    }[];
    expect(asked.map((q) => q.namespace)).toEqual([null, "billing", "shop"]);
    expect(info.canPatchClusters).toBe(false);
    expect(info.patchIn.get("billing")).toBe(true);
    expect(info.patchIn.get("shop")).toBe(false);
  });

  /** An access review that failed is not a refusal. */
  it("leaves the permission unknown when the review itself failed", async () => {
    listDeployments.mockResolvedValue([]);
    checkAccess.mockRejectedValue(new Error("no"));
    const info = (await useOperatorRead()()) as {
      canPatchClusters: boolean | null;
    };
    expect(info.canPatchClusters).toBeNull();
  });
});
