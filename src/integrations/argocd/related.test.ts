/**
 * The Application was the object in this app with the most connections and
 * the only surface that showed none. What it manages is not something the
 * backend's graph can compute — it is a list Argo wrote — so the whole of the
 * answer is a reading of `status.resources`, and the reading must not turn
 * Argo's silence into a verdict.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";

const listCustomResources = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (...args: unknown[]) => listCustomResources(...args),
  },
}));

const { relatedTo } = await import("./related");

function application(resources: unknown[]): CustomResourceInfo {
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
        relation: "governed by",
        kind: "AppProject",
        name: "prod",
      }),
      expect.objectContaining({
        relation: "manages",
        name: "api",
        tone: undefined,
      }),
      expect.objectContaining({ relation: "manages", kind: "Service" }),
    ]);
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
    expect(related?.filter((entry) => entry.relation === "manages")).toEqual(
      []
    );
  });

  it("answers about a kind it owns even when the object is gone", async () => {
    listCustomResources.mockResolvedValue([]);
    expect(await relatedTo(subject)).toEqual([]);
  });
});
