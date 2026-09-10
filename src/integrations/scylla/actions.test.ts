import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { actionsFor, opsFor, patchFor } from "./actions";
import { readScyllaCluster } from "./model";

const resource: CustomResourceInfo = {
  name: "events",
  namespace: "events",
  uid: "uid",
  apiVersion: "scylla.scylladb.com/v1",
  kind: "ScyllaCluster",
  spec: {
    version: "2025.2.1",
    datacenter: {
      name: "eu",
      racks: [
        { name: "eu-1a", members: 3 },
        { name: "eu-1b", members: 3 },
      ],
    },
  },
  status: { members: 6, readyMembers: 6 },
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: null,
};

describe("Scylla actions", () => {
  const cluster = readScyllaCluster(resource, 3);

  /**
   * A merge patch cannot edit one element of a list — it replaces the list.
   * Re-sending `spec.datacenter.racks` rebuilt from what this page models
   * therefore deleted every field the model does not carry, from every rack.
   * Reproduced against a real apiserver: scaling one rack from 3 to 5 left
   * `[{name, members}]`, and a live rack also carries `storage` — the volume
   * claim for the data — plus `resources`, `placement` and both configs.
   *
   * So scaling is a JSON Patch that names one number, and a `test` op that
   * names the rack that index is expected to hold: if the list moved since
   * the page read it, the apiserver rejects the whole patch instead of
   * resizing somebody else's rack.
   */
  it("scales one rack by naming one number, guarded by the rack at that index", () => {
    const scale = actionsFor(cluster, true).find(
      (a) =>
        a.id === "scale" &&
        a.input?.kind === "members" &&
        a.input.rack === "eu-1b"
    );
    expect(scale).toBeDefined();
    expect(opsFor(scale!, cluster, "5")).toEqual([
      { op: "test", path: "/spec/datacenter/racks/1/name", value: "eu-1b" },
      { op: "replace", path: "/spec/datacenter/racks/1/members", value: 5 },
    ]);
    expect(() => opsFor(scale!, cluster, "many")).toThrow(/whole number/);
    // Nothing about scaling may go out as a merge patch any more.
    expect(() => patchFor(scale!, "5")).toThrow(/JSON Patch/);
  });

  it("restarts through the field the operator watches, stamped so it changes every time", () => {
    const restart = actionsFor(cluster, true).find((a) => a.id === "restart")!;
    const at = new Date("2026-09-07T21:14:00Z");
    expect(patchFor(restart, "", at)).toEqual({
      spec: { forceRedeploymentReason: "rubick 2026-09-07T21:14:00.000Z" },
    });
  });

  it("refuses a version that is not one, and holds every knob during an upgrade", () => {
    const upgrade = actionsFor(cluster, true).find((a) => a.id === "upgrade")!;
    expect(() => patchFor(upgrade, "latest")).toThrow(/looks like/);
    expect(patchFor(upgrade, "2025.3.0")).toEqual({
      spec: { version: "2025.3.0" },
    });

    const mid = readScyllaCluster(
      {
        ...resource,
        status: {
          upgrade: {
            state: "RunningUpgrade",
            fromVersion: "2025.2.1",
            toVersion: "2025.3.0",
          },
        },
      },
      3
    );
    expect(
      actionsFor(mid, true).every((a) => a.reason === "notDuringUpgrade")
    ).toBe(true);
    expect(
      actionsFor(cluster, false).every((a) => a.reason === "refusedPatchScylla")
    ).toBe(true);
    expect(actionsFor(cluster, null).every((a) => a.reason === null)).toBe(
      true
    );
  });
});
