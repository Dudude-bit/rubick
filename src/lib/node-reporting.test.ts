import { describe, expect, it } from "vitest";

import type { ConditionInfo, NodeInfo } from "@/generated/types";

import { silenceNote, silenceOf, silentNodes } from "./node-reporting";

function condition(
  status: string,
  extra?: Partial<ConditionInfo>
): ConditionInfo {
  return {
    type: "Ready",
    status,
    reason: null,
    message: null,
    lastTransitionTime: null,
    ...extra,
  };
}

function node(name: string, conditions: ConditionInfo[]): NodeInfo {
  return {
    name,
    uid: `uid-${name}`,
    status: { ready: false, conditions, addresses: [] },
    roles: [],
    version: "v1.31.0",
    os: "linux",
    arch: "amd64",
    containerRuntime: "containerd://1.7.0",
    labels: {},
    taints: [],
    capacity: { cpu: null, memory: null, pods: null, storage: null },
    allocatable: { cpu: null, memory: null, pods: null, storage: null },
    providerId: null,
    createdAt: null,
  } as unknown as NodeInfo;
}

describe("which nodes stopped reporting", () => {
  /**
   * The whole point. `Unknown` is what the node controller writes when the
   * heartbeats stop, and it is the only state in which a pod's status is a
   * description of the past.
   */
  it("counts a node whose Ready went Unknown", () => {
    const silent = silentNodes([node("n1", [condition("Unknown")])]);
    expect([...silent.keys()]).toEqual(["n1"]);
  });

  /**
   * Would have made the warning useless. A node that reports NotReady is a
   * node that is still talking: disk pressure, a failing CNI, a drain in
   * progress — every pod status on it is current. Marking those stale would
   * fire the warning on ordinary unhealthy clusters, which is how a warning
   * stops being read.
   */
  it("does not count a node that says NotReady itself", () => {
    const silent = silentNodes([node("n1", [condition("False")])]);
    expect(silent.size).toBe(0);
  });

  it("does not count a healthy node", () => {
    const silent = silentNodes([node("n1", [condition("True")])]);
    expect(silent.size).toBe(0);
  });

  /** A node mid-registration has no Ready condition at all, and no answer. */
  it("counts a node with no Ready condition", () => {
    const silent = silentNodes([node("n1", [])]);
    expect(silent.size).toBe(1);
  });

  it("keeps when it happened and why, when the API said", () => {
    const silent = silentNodes([
      node("n1", [
        condition("Unknown", {
          lastTransitionTime: "2026-08-17T10:00:00Z",
          reason: "NodeStatusUnknown",
        }),
      ]),
    ]);
    expect(silent.get("n1")).toEqual({
      node: "n1",
      since: "2026-08-17T10:00:00Z",
      reason: "NodeStatusUnknown",
    });
  });
});

describe("the silence covering a pod", () => {
  const silent = silentNodes([node("gone", [condition("Unknown")])]);

  it("finds it by the pod's node", () => {
    expect(silenceOf("gone", silent)?.node).toBe("gone");
  });

  it("is nothing for a pod on a healthy node", () => {
    expect(silenceOf("fine", silent)).toBeNull();
  });

  /** An unscheduled pod has no node, so nothing is stale about it. */
  it("is nothing for a pod with no node yet", () => {
    expect(silenceOf(null, silent)).toBeNull();
    expect(silenceOf(undefined, silent)).toBeNull();
  });
});

describe("the sentence on the row", () => {
  const now = new Date("2026-08-17T10:05:00Z");

  it("says how long ago, and that the status is old rather than wrong", () => {
    const note = silenceNote(
      { node: "n1", since: "2026-08-17T10:00:00Z", reason: null },
      now
    );
    expect(note).toBe(
      "Node n1 stopped reporting 5m ago. This status is the last one it sent, not the pod's state now."
    );
  });

  it("still warns when the API did not say when", () => {
    const note = silenceNote({ node: "n1", since: null, reason: null }, now);
    expect(note).toBe(
      "Node n1 stopped reporting. This status is the last one it sent, not the pod's state now."
    );
  });

  /**
   * A desktop clock behind the cluster's would otherwise render "-3m ago",
   * which reads as a bug here rather than as a clock that disagrees.
   */
  it("omits a duration it would have to render negative", () => {
    const note = silenceNote(
      { node: "n1", since: "2026-08-17T10:30:00Z", reason: null },
      now
    );
    expect(note).not.toContain("-");
    expect(note).toBe(
      "Node n1 stopped reporting. This status is the last one it sent, not the pod's state now."
    );
  });

  it("scales past an hour", () => {
    expect(
      silenceNote(
        { node: "n1", since: "2026-08-17T07:00:00Z", reason: null },
        now
      )
    ).toContain("3h ago");
    expect(
      silenceNote(
        { node: "n1", since: "2026-08-14T10:00:00Z", reason: null },
        now
      )
    ).toContain("3d ago");
  });
});
