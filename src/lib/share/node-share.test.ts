import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { NodeInfo, PodInfo } from "@/generated/types";
import {
  nodeAddressesFacts,
  nodeStatusOf,
  podsOnNodeSection,
  taintsSection,
} from "./node-share";

const t: T = (section, key, values) => translate("en", section, key, values);

function node(over: Partial<NodeInfo> = {}): NodeInfo {
  return {
    name: "node-a",
    uid: "u1",
    status: { ready: true, conditions: [], addresses: [] },
    roles: [],
    version: "v1.32.0",
    os: "linux",
    arch: "arm64",
    containerRuntime: "containerd://1.7",
    labels: {},
    taints: [],
    unschedulable: false,
    capacity: { cpu: "4", memory: "16Gi", pods: "110", ephemeralStorage: null },
    allocatable: {
      cpu: "4",
      memory: "16Gi",
      pods: "110",
      ephemeralStorage: null,
    },
    providerId: null,
    createdAt: null,
    ...over,
  };
}

describe("what the node's own status says in the file", () => {
  /** A node not ready is the fault; losing that under a pressure note would hide it. */
  it("says err when the node itself is not ready", () => {
    const status = nodeStatusOf(
      node({ status: { ready: false, conditions: [], addresses: [] } })
    );
    expect(status.role).toBe("err");
    expect(status.text).toBe("NotReady");
  });

  /** `Ready` alone hides a kubelet refusing pods over memory. */
  it("names an active pressure condition beside a ready node", () => {
    const status = nodeStatusOf(
      node({
        status: {
          ready: true,
          conditions: [
            {
              type: "MemoryPressure",
              status: "True",
              reason: null,
              message: null,
              lastTransitionTime: null,
            },
          ],
          addresses: [],
        },
      })
    );
    expect(status.role).toBe("warn");
    expect(status.text).toContain("MemoryPressure");
  });
});

describe("the pods-on-node table", () => {
  /**
   * The pods list is fetched only while the Pods tab is open. Reading
   * `undefined` as an empty table would turn "not looked at" into "no pods
   * on this node", the exact bug this app exists to never make.
   */
  it("says the tab was not opened instead of printing an empty table", () => {
    const section = podsOnNodeSection(undefined, null, t);
    expect(section.unread).toBeTruthy();
    expect(section.body).toMatchObject({ type: "table", rows: [] });
  });

  it("carries the pod as a reference once the tab has read it", () => {
    const pod = {
      name: "payments-abc",
      namespace: "shop",
      status: {
        phase: "Running",
        display: "Running",
        ready: true,
        conditions: [],
        message: null,
        reason: null,
      },
      restartCount: 0,
      createdAt: null,
    } as unknown as PodInfo;
    const section = podsOnNodeSection([pod], null, t);
    expect(section.unread).toBeNull();
    expect(section.body).toMatchObject({ type: "table" });
    if (section.body.type !== "table") throw new Error("expected a table");
    expect(section.body.rows[0].cells[0]).toMatchObject({
      text: "payments-abc",
      ref: { kind: "Pod", stem: "payments-abc" },
    });
  });
});

describe("taints", () => {
  it("marks anything sharper than PreferNoSchedule as a warning", () => {
    const section = taintsSection(
      [{ key: "dedicated", value: "gpu", effect: "NoSchedule" }],
      t
    );
    expect(section).not.toBeNull();
    if (!section || section.body.type !== "table")
      throw new Error("expected a table");
    expect(section.body.rows[0].cells[2]).toMatchObject({
      text: "NoSchedule",
      role: "warn",
    });
  });

  it("is absent rather than an empty section when the node has none", () => {
    expect(taintsSection([], t)).toBeNull();
  });
});

describe("addresses", () => {
  it("drops a facts row for an address type the node never reported", () => {
    const section = nodeAddressesFacts(
      node({
        status: {
          ready: true,
          conditions: [],
          addresses: [{ type: "InternalIP", address: "10.0.0.4" }],
        },
      }),
      t
    );
    expect(section).not.toBeNull();
    if (!section || section.body.type !== "facts")
      throw new Error("expected facts");
    expect(section.body.rows).toHaveLength(1);
    expect(section.body.rows[0].values[0].text).toBe("10.0.0.4");
  });
});
