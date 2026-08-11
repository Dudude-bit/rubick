import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import type { DeliveryQuery } from "../gitops";

const listCustomResources = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (...args: unknown[]) => listCustomResources(...args),
  },
}));

const { ownerOf } = await import("./owner");

function application(
  over: Partial<CustomResourceInfo> & { resources?: unknown[] } = {}
): CustomResourceInfo {
  const { resources, ...rest } = over;
  return {
    name: "shop",
    namespace: "argocd",
    uid: "u",
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    createdAt: null,
    labels: {},
    annotations: {},
    ownerReferences: [],
    spec: {
      project: "prod",
      source: { repoURL: "https://github.com/acme/infra", path: "manifests" },
      syncPolicy: { automated: { selfHeal: true } },
    },
    status: {
      sync: { status: "Synced", revision: "a3f21c9" },
      health: { status: "Healthy" },
      resources: resources ?? [
        { group: "apps", kind: "Deployment", namespace: "shop", name: "api" },
      ],
    },
    ...rest,
  } as unknown as CustomResourceInfo;
}

const api = (over: Partial<DeliveryQuery> = {}): DeliveryQuery => ({
  group: "apps",
  kind: "Deployment",
  name: "api",
  namespace: "shop",
  labels: {},
  annotations: {
    "argocd.argoproj.io/tracking-id": "shop:apps/Deployment:shop/api",
  },
  ...over,
});

beforeEach(() => {
  listCustomResources.mockReset();
});

describe("the claim is resolved, never trusted", () => {
  /**
   * The test that fails if an unconfirmed label ever starts being asserted as
   * delivery. An Application called `shop` exists and does *not* list this
   * object — a manifest committed with the tracking annotation already in it,
   * or an object left behind by a sync that no longer owns it. Reporting that
   * as delivered would put a revision, a repository and a "your edit will be
   * reverted" warning on screen for a relationship nothing is enforcing.
   */
  it("reports a labelled object the Application does not list as claimed", async () => {
    listCustomResources.mockResolvedValue([
      application({ resources: [{ kind: "Deployment", name: "web" }] }),
    ]);

    const [answer] = await ownerOf([api()]);
    expect(answer?.state).toBe("claimed");
    expect(answer).toMatchObject({ claim: "shop", ownerKind: "Application" });
    expect(answer).not.toHaveProperty("source");
  });

  it("distinguishes an owner that disowns it from one that does not exist", async () => {
    listCustomResources.mockResolvedValue([]);
    const [answer] = await ownerOf([api()]);
    expect(answer).toMatchObject({ state: "claimed", owner: null });
  });

  it("reports delivery only once the Application names the object back", async () => {
    listCustomResources.mockResolvedValue([application()]);
    const [answer] = await ownerOf([api()]);
    expect(answer?.state).toBe("delivered");
    if (answer?.state !== "delivered") throw new Error("unreachable");
    expect(answer.source.owner.name).toBe("shop");
    expect(answer.source.drift).toBe("reverted");
    expect(answer.source.path).toBe("manifests");
  });

  it("says nothing at all about an object carrying no claim", async () => {
    const [answer] = await ownerOf([api({ annotations: {}, labels: {} })]);
    expect(answer).toBe(null);
    expect(listCustomResources).not.toHaveBeenCalled();
  });
});

describe("what a five-hundred-row page costs", () => {
  /**
   * One read for the whole page, whatever its length. A per-object entry
   * point would have been a signature that looked honest and made the column
   * impossible.
   */
  it("reads the Applications once for many objects", async () => {
    listCustomResources.mockResolvedValue([
      application({
        resources: Array.from({ length: 500 }, (_, index) => ({
          kind: "Deployment",
          namespace: "shop",
          name: `api-${index}`,
        })),
      }),
    ]);

    const answers = await ownerOf(
      Array.from({ length: 500 }, (_, index) =>
        api({
          name: `api-${index}`,
          annotations: {
            "argocd.argoproj.io/tracking-id": `shop:apps/Deployment:shop/api-${index}`,
          },
        })
      )
    );

    expect(listCustomResources).toHaveBeenCalledTimes(1);
    expect(
      answers.filter((answer) => answer?.state === "delivered")
    ).toHaveLength(500);
  });

  it("reads nothing at all when no row carries a claim", async () => {
    const answers = await ownerOf(
      Array.from({ length: 500 }, (_, index) =>
        api({ name: `plain-${index}`, annotations: {}, labels: {} })
      )
    );
    expect(listCustomResources).not.toHaveBeenCalled();
    expect(answers.every((answer) => answer === null)).toBe(true);
  });
});

describe("per-object sync, which Argo does publish", () => {
  it("carries Argo's own verdict for the object rather than the app's", async () => {
    listCustomResources.mockResolvedValue([
      application({
        resources: [
          {
            group: "apps",
            kind: "Deployment",
            namespace: "shop",
            name: "api",
            status: "OutOfSync",
          },
        ],
      }),
    ]);
    const [answer] = await ownerOf([api()]);
    if (answer?.state !== "delivered") throw new Error("unreachable");
    expect(answer.source.sync).toBe("drifted");
    expect(answer.source.warning).toBe("out of sync");
  });
});
