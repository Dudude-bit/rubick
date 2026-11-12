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

// The hook only wraps a queryFn; these tests are about that function, so
// `useQuery` hands it back instead of running React.
const lastQueryFn: { current: (() => Promise<unknown>) | null } = {
  current: null,
};
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryFn: () => Promise<unknown> }) => {
    lastQueryFn.current = opts.queryFn;
    return {};
  },
}));

const { allowedOn, useOperator } = await import("./data");

/** The queryFn as `useQuery` would call it, without React. */
function useOperatorRead(
  clusters: readonly { namespace: string; name: string }[] = []
): () => Promise<unknown> {
  useOperator(clusters);
  const fn = lastQueryFn.current;
  if (!fn) throw new Error("useOperator did not register a queryFn");
  return fn;
}

function deployment(): DeploymentInfo {
  return {
    name: "cnpg-controller-manager",
    namespace: "cnpg-system",
    replicas: { ready: 1, desired: 1 },
    containers: [{ image: "ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0" }],
  } as unknown as DeploymentInfo;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useOperator", () => {
  /**
   * A reader who may see CNPG's Clusters but not the cluster's Deployments is
   * an ordinary namespace-scoped RBAC user. Answering their refused list with
   * `[]` printed "no Deployment carries app.kubernetes.io/name=cloudnative-pg;
   * the operator may not be here" — a confident claim about a read nobody got,
   * on the one page whose whole purpose is to say what it could not read.
   */
  it("says whether the controller is running is unknown when the read was refused", async () => {
    listDeployments.mockRejectedValue(new Error("deployments is forbidden"));
    checkAccess.mockResolvedValue([{ allowed: true }, { allowed: true }]);
    const info = (await useOperatorRead()()) as {
      controller: unknown;
      controllerKnown: boolean;
      controllerReason: string | null;
    };
    expect(info.controllerKnown).toBe(false);
    expect(info.controller).toBeNull();
    expect(info.controllerReason).toMatch(/forbidden/);
  });

  /** A read that succeeded and found nothing is the other answer, and stays it. */
  it("says the controller is absent only on a read that found nothing", async () => {
    listDeployments.mockResolvedValue([]);
    checkAccess.mockResolvedValue([{ allowed: true }, { allowed: true }]);
    const info = (await useOperatorRead()()) as {
      controller: unknown;
      controllerKnown: boolean;
    };
    expect(info.controllerKnown).toBe(true);
    expect(info.controller).toBeNull();
  });

  /** And a read that found it reports it, with the version off the image tag. */
  it("reads the controller and its version from the Deployment it found", async () => {
    listDeployments.mockResolvedValue([deployment()]);
    checkAccess.mockResolvedValue([{ allowed: true }, { allowed: false }]);
    const info = (await useOperatorRead()()) as {
      controller: { name: string } | null;
      controllerKnown: boolean;
      version: string | null;
      canCreateBackups: boolean | null;
    };
    expect(info.controllerKnown).toBe(true);
    expect(info.controller?.name).toBe("cnpg-controller-manager");
    expect(info.version).toBe("1.30.0");
    expect(info.canCreateBackups).toBe(false);
  });

  /**
   * A Role may grant `patch` on one named Cluster, and RBAC answers no to
   * the nameless question for it: asked per namespace, every action on the
   * one Cluster the reader may act on came up refused. Patch is asked of
   * each Cluster by name; a create has no name to match and is asked per
   * namespace. Fails if the name leaves the question.
   */
  it("asks patch of each Cluster by name, and create in each namespace", async () => {
    listDeployments.mockResolvedValue([deployment()]);
    checkAccess.mockResolvedValue([
      // Cluster-wide: no to both.
      { allowed: false },
      { allowed: false },
      // billing/ledger: no. shop/orders: yes.
      { allowed: false },
      { allowed: true },
      // Backups in billing: yes. In shop: the review would not say.
      { allowed: true },
      { allowed: null },
    ]);
    const orders = { namespace: "shop", name: "orders" };
    const ledger = { namespace: "billing", name: "ledger" };
    const info = (await useOperatorRead([orders, ledger])()) as Parameters<
      typeof allowedOn
    >[0];
    const asked = checkAccess.mock.lastCall?.[0] as Record<string, unknown>[];
    expect(asked.map((q) => [q.verb, q.resource, q.namespace, q.name])).toEqual(
      [
        ["patch", "clusters", null, undefined],
        ["create", "backups", null, undefined],
        ["patch", "clusters", "billing", "ledger"],
        ["patch", "clusters", "shop", "orders"],
        ["create", "backups", "billing", undefined],
        ["create", "backups", "shop", undefined],
      ]
    );
    expect(info?.canPatchClusters).toBe(false);
    expect(allowedOn(info, orders)).toEqual({
      patchClusters: true,
      createBackups: null,
    });
    expect(allowedOn(info, ledger)).toEqual({
      patchClusters: false,
      createBackups: true,
    });
  });

  /**
   * The cluster-wide "no" says nothing of one Cluster: read as its answer,
   * it refused a Cluster nobody had asked about. Fails if a Cluster with no
   * answer of its own borrows the cluster-wide one.
   */
  it("does not answer for a Cluster it did not ask about", async () => {
    listDeployments.mockResolvedValue([deployment()]);
    checkAccess.mockResolvedValue([{ allowed: false }, { allowed: false }]);
    const info = (await useOperatorRead()()) as Parameters<typeof allowedOn>[0];
    expect(allowedOn(info, { namespace: "shop", name: "orders" })).toEqual({
      patchClusters: null,
      createBackups: null,
    });
    expect(allowedOn(undefined, { namespace: "shop", name: "orders" })).toEqual(
      { patchClusters: null, createBackups: null }
    );
  });

  /**
   * The permission probe has the same three answers, and an unknown one must
   * not read as refused — a greyed-out button is a claim too.
   */
  it("leaves the permissions unknown when the access review itself failed", async () => {
    listDeployments.mockResolvedValue([deployment()]);
    checkAccess.mockRejectedValue(new Error("no"));
    const info = (await useOperatorRead()()) as {
      canPatchClusters: boolean | null;
      canCreateBackups: boolean | null;
    };
    expect(info.canPatchClusters).toBeNull();
    expect(info.canCreateBackups).toBeNull();
  });
});
