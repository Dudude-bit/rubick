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

const { useOperator } = await import("./data");

/** The queryFn as `useQuery` would call it, without React. */
function useOperatorRead(
  namespaces: readonly string[] = []
): () => Promise<unknown> {
  useOperator(namespaces);
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
   * A `SelfSubjectAccessReview` with no namespace asks "in EVERY namespace",
   * and a reader granted `patch clusters` in their own namespace answers no.
   * Asked only that way, every action on their own cluster came up disabled
   * saying the cluster refuses it. The verbs are asked where the Clusters are.
   */
  it("asks the verbs in each namespace a cluster was found in", async () => {
    listDeployments.mockResolvedValue([deployment()]);
    // cluster-wide: no. shop: yes. billing: no.
    checkAccess.mockResolvedValue([
      { allowed: false },
      { allowed: false },
      { allowed: true },
      { allowed: true },
      { allowed: false },
      { allowed: false },
    ]);
    const info = (await useOperatorRead(["shop", "billing"])()) as {
      canPatchClusters: boolean | null;
      patchIn: Map<string | null, boolean | null>;
      createIn: Map<string | null, boolean | null>;
    };
    const asked = checkAccess.mock.lastCall?.[0] as {
      namespace: string | null;
    }[];
    expect(asked.map((q) => q.namespace)).toEqual([
      null,
      null,
      "billing",
      "billing",
      "shop",
      "shop",
    ]);
    expect(info.canPatchClusters).toBe(false);
    expect(info.patchIn.get("billing")).toBe(true);
    expect(info.patchIn.get("shop")).toBe(false);
    expect(info.createIn.get("billing")).toBe(true);
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
