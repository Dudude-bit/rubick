import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

describe("an Application outside Argo's own namespace", () => {
  const web = (namespace: string) =>
    application({
      name: "web",
      namespace,
      resources: [
        { group: "apps", kind: "Deployment", namespace: "prod", name: "web" },
      ],
    });
  const deployment = (over: Partial<DeliveryQuery>) =>
    api({ name: "web", namespace: "prod", annotations: {}, ...over });

  /**
   * Argo names such an Application `<namespace>_<name>` on what it applies.
   * Looked up whole, `team-a_web` matched nothing, so the Deployment read
   * "no Application by that name exists" and "this apply stands" while
   * self-heal reverted the edit. Fails if the namespace is not cut off the
   * name, by either tracking method.
   */
  it.each([
    [
      "the tracking annotation",
      {
        annotations: {
          "argocd.argoproj.io/tracking-id":
            "team-a_web:apps/Deployment:prod/web",
        },
      },
    ],
    [
      "the instance label",
      { labels: { "argocd.argoproj.io/instance": "team-a_web" } },
    ],
  ])("is found from %s", async (_how, claim) => {
    listCustomResources.mockResolvedValue([web("team-a")]);
    const [answer] = await ownerOf([deployment(claim)]);
    if (answer?.state !== "delivered") throw new Error("not delivered");
    expect(answer.source.owner).toMatchObject({
      name: "web",
      namespace: "team-a",
    });
    expect(answer.source.drift).toBe("reverted");
  });

  /**
   * The namespace in the claim is part of the name. Fails if a namesake in
   * another namespace, listing an object of the same name, answers for it.
   */
  it("is not answered for by a namesake in another namespace", async () => {
    listCustomResources.mockResolvedValue([web("team-b")]);
    const [answer] = await ownerOf([
      deployment({ labels: { "argocd.argoproj.io/instance": "team-a_web" } }),
    ]);
    expect(answer).toMatchObject({
      state: "claimed",
      claim: "team-a_web",
      owner: null,
    });
  });
});

describe("the label Argo shares with every Helm chart", () => {
  const labelled = (instance: string) =>
    api({
      annotations: {},
      labels: { "app.kubernetes.io/instance": instance },
    });

  /**
   * Argo CD 2.x from the plain manifests tracks by `app.kubernetes.io/instance`
   * and writes neither the annotation nor its own label. Every object it
   * managed read "not delivered" and no dialog warned. Fails if that key
   * stops finding the Application that lists the object.
   */
  it("finds the Application that lists the object", async () => {
    listCustomResources.mockResolvedValue([application()]);
    const [answer] = await ownerOf([labelled("shop")]);
    if (answer?.state !== "delivered") throw new Error("not delivered");
    expect(answer.source.owner.name).toBe("shop");
  });

  /**
   * A Helm release called `shop` carries the same label. Fails if that is
   * called a claim on Argo: every chart-installed object would turn into
   * "labelled, not listed".
   */
  it.each([
    [
      "an Application of that name does not list it",
      [{ kind: "Deployment", name: "other" }],
    ],
    ["no Application has that name", null],
  ])("says nothing where %s", async (_why, resources) => {
    listCustomResources.mockResolvedValue(
      resources ? [application({ resources })] : []
    );
    expect(await ownerOf([labelled("shop")])).toEqual([null]);
  });

  /** Fails if a chart's own label is read before the annotation Argo wrote. */
  it("gives way to Argo's own annotation", async () => {
    listCustomResources.mockResolvedValue([application()]);
    const [answer] = await ownerOf([
      api({ labels: { "app.kubernetes.io/instance": "some-release" } }),
    ]);
    expect(answer?.state).toBe("delivered");
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

describe("an Application whose automated sync is disabled", () => {
  /**
   * `enabled: false` beside `selfHeal: true` syncs nothing, and every object
   * of such an Application warned that an edit would be put back. Fails if
   * self-heal is read without asking whether auto-sync runs at all.
   */
  it("does not warn that an edit will be undone", async () => {
    const app = application();
    listCustomResources.mockResolvedValue([
      {
        ...app,
        spec: {
          ...(app.spec as object),
          syncPolicy: { automated: { enabled: false, selfHeal: true } },
        },
      },
    ]);
    const [answer] = await ownerOf([api()]);
    if (answer?.state !== "delivered") throw new Error("unreachable");
    expect(answer.source.drift).toBe("kept");
    expect(answer.source.note?.key).toBe("argoNoAutoSync");
  });
});

describe("while the Application is syncing", () => {
  /**
   * Argo clears `finishedAt` while an operation runs, and the delivery line
   * of every managed object lost its "since". Fails if the last recorded
   * sync stops being when the owner last applied.
   */
  it("still says when the Application last applied", async () => {
    const app = application();
    listCustomResources.mockResolvedValue([
      {
        ...app,
        status: {
          ...(app.status as object),
          operationState: {
            phase: "Running",
            startedAt: "2026-08-07T10:00:00Z",
          },
          history: [{ id: 0, deployedAt: "2026-08-01T09:00:00Z" }],
        },
      },
    ]);
    const [answer] = await ownerOf([api()]);
    if (answer?.state !== "delivered") throw new Error("unreachable");
    expect(answer.source.lastAppliedAt).toBe("2026-08-01T09:00:00Z");
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
    expect(answer.source.warning?.key).toBe("argoOutOfSync");
  });
});
