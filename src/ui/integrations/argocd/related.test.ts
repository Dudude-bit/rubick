/**
 * The Application was the object in this app with the most connections and
 * the only surface that showed none. What it manages is not something the
 * backend's graph can compute — it is a list Argo wrote — so the whole of the
 * answer is a reading of `status.resources`, and the reading must not turn
 * Argo's silence into a verdict.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";

const listCustomResources = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (...args: unknown[]) => listCustomResources(...args),
  },
}));

const { relatedTo } = await import("./related");

function application(
  resources: unknown[],
  destination: Record<string, unknown> = {
    server: "https://kubernetes.default.svc",
  }
): CustomResourceInfo {
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
      destination,
    },
    status: {
      sync: { status: "Synced" },
      health: { status: "Healthy" },
      resources,
    },
  } as unknown as CustomResourceInfo;
}

const subject = {
  group: "argoproj.io",
  kind: "Application",
  namespace: "argocd",
  name: "shop",
};

beforeEach(() => listCustomResources.mockReset());

describe("what an Argo Application is connected to", () => {
  it("declines a kind that is not Argo's, without saying it has none", async () => {
    expect(
      await relatedTo({
        group: "cert-manager.io",
        kind: "Certificate",
        namespace: "shop",
        name: "tls",
      })
    ).toBeNull();
    expect(listCustomResources).not.toHaveBeenCalled();
  });

  /**
   * `argoproj.io` also holds ApplicationSet and AppProject, and neither
   * states its relations on itself — declining by group alone would answer
   * for both with an Application's reading.
   */
  it("declines Argo's other kinds too", async () => {
    expect(await relatedTo({ ...subject, kind: "ApplicationSet" })).toBeNull();
  });

  it("lists what Argo says it manages, and the project governing it", async () => {
    listCustomResources.mockResolvedValue([
      application([
        { group: "apps", kind: "Deployment", namespace: "shop", name: "api" },
        { group: "", kind: "Service", namespace: "shop", name: "api" },
      ]),
    ]);

    const related = await relatedTo(subject);
    expect(related).toEqual([
      expect.objectContaining({
        relation: "relGovernedBy",
        kind: "AppProject",
        name: "prod",
      }),
      expect.objectContaining({
        relation: "relManages",
        name: "api",
        tone: undefined,
      }),
      expect.objectContaining({ relation: "relManages", kind: "Service" }),
    ]);
  });

  /**
   * AppProjects live in Argo's own namespace, and an Application may live
   * in any other. The row put the project beside the Application, so the
   * link opened an AppProject that is not there. Fails if the project's
   * namespace is taken from the Application without asking.
   */
  it("finds the project in Argo's namespace for an Application outside it", async () => {
    const app = { ...application([]), namespace: "team-a" };
    listCustomResources.mockImplementation((crd: string) =>
      Promise.resolve(
        crd === "appprojects.argoproj.io"
          ? [
              { name: "other", namespace: "team-a" },
              { name: "prod", namespace: "argocd" },
            ]
          : [app]
      )
    );

    const related = await relatedTo({ ...subject, namespace: "team-a" });
    expect(related?.[0]).toMatchObject({
      kind: "AppProject",
      name: "prod",
      namespace: "argocd",
    });
  });

  /** Fails if a project of the same name elsewhere is preferred to the one beside the Application. */
  it("keeps the project beside the Application where there is one", async () => {
    listCustomResources.mockImplementation((crd: string) =>
      Promise.resolve(
        crd === "appprojects.argoproj.io"
          ? [
              { name: "prod", namespace: "another-argo" },
              { name: "prod", namespace: "argocd" },
            ]
          : [application([])]
      )
    );
    expect((await relatedTo(subject))?.[0]).toMatchObject({
      namespace: "argocd",
    });
  });

  /**
   * Fails if a refused AppProject list is answered with "none", which puts
   * the project back beside the Application with nothing said.
   */
  it("does not guess where the project is when the projects could not be listed", async () => {
    listCustomResources.mockImplementation((crd: string) =>
      crd === "appprojects.argoproj.io"
        ? Promise.reject(new Error("appprojects is forbidden"))
        : Promise.resolve([application([])])
    );
    await expect(relatedTo(subject)).rejects.toThrow(
      "appprojects is forbidden"
    );
  });

  /**
   * The group travels with the row so the consumer can turn it into a CRD
   * name. Without it a managed `Certificate` is unopenable text — which is
   * exactly what half of a real Application's inventory used to be.
   */
  it("carries the far end's API group", async () => {
    listCustomResources.mockResolvedValue([
      application([
        {
          group: "cert-manager.io",
          kind: "Certificate",
          namespace: "shop",
          name: "tls",
        },
      ]),
    ]);

    const related = await relatedTo(subject);
    expect(related?.[1]).toMatchObject({
      kind: "Certificate",
      group: "cert-manager.io",
    });
  });

  /**
   * A tone is drawn on the note, so a resource with a tone and no note came
   * out looking exactly like a healthy one — and `Missing`, the loudest state
   * Argo reports, is precisely the one it writes no message for.
   */
  it("falls back to Argo's own state word where it wrote no message", async () => {
    listCustomResources.mockResolvedValue([
      application([
        {
          group: "traefik.io",
          kind: "Middleware",
          namespace: "shop",
          name: "redirect",
          status: "Missing",
          health: {},
        },
      ]),
    ]);

    const related = await relatedTo(subject);
    expect(related?.[1]).toMatchObject({ tone: "err", note: "Missing" });
  });

  /**
   * A hub's Application for a spoke lists the spoke's objects, and the tab
   * linked each to the hub's namesake. Fails if a row of an Application that
   * deploys elsewhere stops saying which cluster it is in.
   */
  it("says which cluster a managed object is in where that is not this one", async () => {
    const prometheus = {
      group: "apps",
      kind: "Deployment",
      namespace: "monitoring",
      name: "prometheus-operator",
    };
    listCustomResources.mockResolvedValue([
      application([prometheus], { name: "spoke1" }),
    ]);
    expect((await relatedTo(subject))?.[1]).toMatchObject({
      name: "prometheus-operator",
      cluster: "spoke1",
    });

    listCustomResources.mockResolvedValue([application([prometheus])]);
    expect((await relatedTo(subject))?.[1]).not.toHaveProperty("cluster");
  });

  it("leaves a healthy resource with nothing to say", async () => {
    listCustomResources.mockResolvedValue([
      application([
        {
          group: "",
          kind: "Service",
          namespace: "shop",
          name: "api",
          status: "Synced",
          health: { status: "Healthy" },
        },
      ]),
    ]);

    const related = await relatedTo(subject);
    expect(related?.[1]).toMatchObject({ note: null, tone: undefined });
  });

  it("colours a failed apply and repeats Argo's own sentence", async () => {
    listCustomResources.mockResolvedValue([
      application([
        {
          group: "apps",
          kind: "Deployment",
          namespace: "shop",
          name: "api",
          status: "OutOfSync",
          health: { status: "Degraded" },
          syncPhase: "Sync",
        },
      ]),
    ]);

    const related = await relatedTo(subject);
    expect(related?.[1]).toMatchObject({ tone: "err" });
  });

  /**
   * The distinction the whole capability turns on. An Application Argo has
   * not compared yet lists nothing — that is a fact about the object, and it
   * must not come back as `null`, which means "no integration knows this
   * kind".
   */
  it("answers with an empty list, not a refusal, when it lists nothing", async () => {
    listCustomResources.mockResolvedValue([application([])]);
    const related = await relatedTo(subject);
    expect(related).not.toBeNull();
    expect(related?.filter((entry) => entry.relation === "relManages")).toEqual(
      []
    );
  });

  it("answers about a kind it owns even when the object is gone", async () => {
    listCustomResources.mockResolvedValue([]);
    expect(await relatedTo(subject)).toEqual([]);
  });
});
