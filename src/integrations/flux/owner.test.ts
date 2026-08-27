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

function kustomization(entries: string[], over: object = {}) {
  return {
    name: "apps",
    namespace: "flux-system",
    kind: "Kustomization",
    labels: {},
    annotations: {},
    ownerReferences: [],
    spec: { interval: "10m", path: "./kustomize" },
    status: {
      inventory: { entries: entries.map((id) => ({ id })) },
      lastAppliedRevision: "master@sha1:eec06d1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          lastTransitionTime: "2026-08-01T00:00:00Z",
        },
      ],
    },
    ...over,
  } as unknown as CustomResourceInfo;
}

const podinfo = (over: Partial<DeliveryQuery> = {}): DeliveryQuery => ({
  group: "apps",
  kind: "Deployment",
  name: "podinfo",
  namespace: "flux-apps",
  labels: {
    "kustomize.toolkit.fluxcd.io/name": "apps",
    "kustomize.toolkit.fluxcd.io/namespace": "flux-system",
  },
  annotations: {},
  ...over,
});

const INVENTORY_ID = "flux-apps_podinfo_apps_Deployment";

beforeEach(() => {
  listCustomResources.mockReset();
  listCustomResources.mockResolvedValue([]);
});

describe("the inventory is the fact, the label is the claim", () => {
  it("reports a labelled object the Kustomization does not list as claimed", async () => {
    listCustomResources.mockResolvedValue([
      kustomization(["flux-apps_other_apps_Deployment"]),
    ]);
    const [answer] = await ownerOf([podinfo()]);
    expect(answer?.state).toBe("claimed");
    expect(answer).not.toHaveProperty("source");
  });

  it("reports delivery once the inventory names the object back", async () => {
    listCustomResources.mockResolvedValue([kustomization([INVENTORY_ID])]);
    const [answer] = await ownerOf([podinfo()]);
    expect(answer?.state).toBe("delivered");
    if (answer?.state !== "delivered") throw new Error("unreachable");
    expect(answer.source.owner.kind).toBe("Kustomization");
    expect(answer.source.drift).toBe("reverted");
  });
});

describe("Flux publishes no per-object drift, and this says so", () => {
  /**
   * Flux re-applies its own fields on a timer and the correction is silent —
   * there is no moment at which anything records that an object had differed.
   * `null` is "nobody here knows"; the one thing this must never do is
   * quietly resolve it to `synced`, which would put a tick beside an object
   * nothing ever compared.
   */
  it("leaves the per-object comparison unstated rather than guessing", async () => {
    listCustomResources.mockResolvedValue([kustomization([INVENTORY_ID])]);
    const [answer] = await ownerOf([podinfo()]);
    if (answer?.state !== "delivered") throw new Error("unreachable");
    expect(answer.source.sync).toBe(null);
  });

  /**
   * What Flux *does* publish is whether the reconciler is running at all, and
   * a suspended one keeps `Ready=True` from the last run that worked — the
   * state that looks perfect.
   */
  it("names a suspended reconciler, which Ready alone would hide", async () => {
    listCustomResources.mockResolvedValue([
      kustomization([INVENTORY_ID], {
        spec: { interval: "10m", path: "./kustomize", suspend: true },
      }),
    ]);
    const [answer] = await ownerOf([podinfo()]);
    if (answer?.state !== "delivered") throw new Error("unreachable");
    expect(answer.source.warning?.key).toBe("fluxSuspendedWord");
    expect(answer.source.drift).toBe("unmanaged");
  });
});

describe("cost", () => {
  it("reads nothing when no object carries a Flux label", async () => {
    const answers = await ownerOf([podinfo({ labels: {} })]);
    expect(listCustomResources).not.toHaveBeenCalled();
    expect(answers).toEqual([null]);
  });

  it("reads only the reconciler kinds something actually claimed", async () => {
    listCustomResources.mockResolvedValue([kustomization([INVENTORY_ID])]);
    await ownerOf([podinfo(), podinfo({ name: "podinfo-2" })]);
    expect(listCustomResources).toHaveBeenCalledTimes(1);
  });
});
