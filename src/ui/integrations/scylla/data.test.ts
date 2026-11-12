import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

const { patchAllowedOn, useOperator } = await import("./data");

function useOperatorRead(
  clusters: readonly { namespace: string; name: string }[] = []
): () => Promise<unknown> {
  useOperator(clusters);
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
   * A Role may grant `patch` on one named ScyllaCluster, and RBAC answers no
   * to the nameless question for it: asked per namespace, every knob on the
   * one cluster the reader may turn came up refused. Fails if the name
   * leaves the question, or an unasked cluster borrows the cluster-wide no.
   */
  it("asks the patch verb of each ScyllaCluster by name", async () => {
    listDeployments.mockResolvedValue([]);
    checkAccess.mockResolvedValue([
      { allowed: false },
      { allowed: false },
      { allowed: true },
    ]);
    const events = { namespace: "shop", name: "events" };
    const ledger = { namespace: "billing", name: "ledger" };
    const info = (await useOperatorRead([events, ledger])()) as Parameters<
      typeof patchAllowedOn
    >[0];
    const asked = checkAccess.mock.lastCall?.[0] as Record<string, unknown>[];
    expect(asked.map((q) => [q.verb, q.resource, q.namespace, q.name])).toEqual(
      [
        ["patch", "scyllaclusters", null, undefined],
        ["patch", "scyllaclusters", "billing", "ledger"],
        ["patch", "scyllaclusters", "shop", "events"],
      ]
    );
    expect(info?.canPatchClusters).toBe(false);
    expect(patchAllowedOn(info, ledger)).toBe(false);
    expect(patchAllowedOn(info, events)).toBe(true);
    expect(
      patchAllowedOn(info, { namespace: "shop", name: "other" })
    ).toBeNull();
    expect(patchAllowedOn(undefined, events)).toBeNull();
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
