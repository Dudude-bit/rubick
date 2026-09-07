import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { actionsFor, patchFor } from "./actions";
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

  /** A merge patch with one rack in the list would delete the other rack; the whole list goes. */
  it("scales one rack by sending every rack with the one number changed", () => {
    const scale = actionsFor(cluster, true).find(
      (a) =>
        a.id === "scale" &&
        a.input?.kind === "members" &&
        a.input.rack === "eu-1b"
    );
    expect(scale).toBeDefined();
    expect(patchFor(scale!, cluster, "5")).toEqual({
      spec: {
        datacenter: {
          racks: [
            { name: "eu-1a", members: 3 },
            { name: "eu-1b", members: 5 },
          ],
        },
      },
    });
    expect(() => patchFor(scale!, cluster, "many")).toThrow(/whole number/);
  });

  it("restarts through the field the operator watches, stamped so it changes every time", () => {
    const restart = actionsFor(cluster, true).find((a) => a.id === "restart")!;
    const at = new Date("2026-09-07T21:14:00Z");
    expect(patchFor(restart, cluster, "", at)).toEqual({
      spec: { forceRedeploymentReason: "rubick 2026-09-07T21:14:00.000Z" },
    });
  });

  it("refuses a version that is not one, and holds every knob during an upgrade", () => {
    const upgrade = actionsFor(cluster, true).find((a) => a.id === "upgrade")!;
    expect(() => patchFor(upgrade, cluster, "latest")).toThrow(/looks like/);
    expect(patchFor(upgrade, cluster, "2025.3.0")).toEqual({
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
