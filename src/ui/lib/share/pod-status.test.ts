import { describe, expect, it } from "vite-plus/test";

import type { PodCause, PodStart } from "@/generated/types";
import { workloadCause, type PodBadgeInput } from "./pod-status";

const NOW = Date.parse("2026-10-15T10:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function notReady(seconds: number): PodBadgeInput {
  return {
    status: {
      phase: "Running",
      display: "Running",
      cause: {
        says: "notReady",
        containers: ["web"],
        since: ago(seconds),
        countsFrom: ago(seconds - 120),
        probe: null,
      },
    },
    start: { state: "starting", until: ago(seconds - 600) },
    containers: [
      { ready: false, started: true, phase: "app", state: { type: "running" } },
    ],
    initContainers: [],
  } as PodBadgeInput;
}

function creating(start: PodStart): PodBadgeInput {
  const cause: PodCause = {
    says: "creating",
    uid: "u1",
    since: ago(5),
    sandbox: false,
    kubelet: { says: "notRead" },
  };
  return {
    status: { phase: "Pending", display: "ContainerCreating", cause },
    start,
    containers: [
      {
        ready: false,
        started: false,
        phase: "app",
        state: { type: "waiting", reason: "ContainerCreating", message: null },
      },
    ],
    initContainers: [],
  } as PodBadgeInput;
}

describe("workloadCause", () => {
  /**
   * A rollout's new pod fails its readiness probe for its first seconds on
   * every start, and the workload led with it each time. Fails if a pod not
   * Ready for seconds is counted beside one not Ready for minutes.
   */
  it("counts a pod not Ready only past the first passes of its probe", () => {
    const told = workloadCause([notReady(300), notReady(30)], NOW);
    expect(told?.warnedOnly).toBe(false);
    expect(told?.shared).toMatchObject({
      cause: { says: "notReady" },
      pods: 1,
      of: 2,
    });
    expect(workloadCause([notReady(30)], NOW)).toBeNull();
  });

  /**
   * A pod inside its wait is coming, not failing, unless its kubelet says
   * otherwise. Fails if pods being set up are told as trouble outright, or
   * dropped before their kubelet is asked.
   */
  it("leaves pods being set up inside their wait to their kubelet's word", () => {
    const inWait = creating({ state: "starting", until: ago(-300) });
    expect(workloadCause([inWait, inWait], NOW)).toMatchObject({
      warnedOnly: true,
      shared: { cause: { says: "creating" }, pods: 2, of: 2 },
    });
    const pastIt = creating({ state: "starting", until: ago(60) });
    expect(workloadCause([pastIt, inWait], NOW)).toMatchObject({
      warnedOnly: false,
      shared: { cause: { says: "creating" }, pods: 1, of: 2 },
    });
  });
});
