import { describe, expect, it } from "vitest";

import { containerStatus } from "./pod-status";
import type { ContainerState, TerminationInfo } from "@/generated/types";

const terminated = (extra: Partial<TerminationInfo> = {}): ContainerState => ({
  type: "terminated",
  termination: {
    exitCode: 0,
    signal: null,
    reason: null,
    message: null,
    startedAt: null,
    finishedAt: null,
    ...extra,
  },
});

describe("containerStatus", () => {
  it("folds readiness into the running state", () => {
    expect(
      containerStatus({ ready: true, state: { type: "running" } })
    ).toEqual({ text: "Running", role: "ok" });
    // Running and failing its readiness probe is the case the old display
    // split across two places: "Running" in the value column and "not ready"
    // beside the heading, each denying the other.
    expect(
      containerStatus({ ready: false, state: { type: "running" } })
    ).toEqual({ text: "Not ready", role: "warn" });
  });

  it("takes the waiting reason as the state", () => {
    expect(
      containerStatus({
        ready: false,
        state: { type: "waiting", reason: "CrashLoopBackOff" },
      })
    ).toEqual({ text: "CrashLoopBackOff", role: "err" });
    expect(
      containerStatus({
        ready: false,
        state: { type: "waiting", reason: "ContainerCreating" },
      })
    ).toEqual({ text: "ContainerCreating", role: "pending" });
  });

  it("calls an unrecognised waiting reason pending, not neutral", () => {
    // Waiting is inherently in-flight; grey would read as "settled".
    expect(
      containerStatus({
        ready: false,
        state: { type: "waiting", reason: "SomeOperatorReason" },
      })
    ).toEqual({ text: "SomeOperatorReason", role: "pending" });
  });

  it("separates a clean exit from a crash", () => {
    expect(containerStatus({ ready: false, state: terminated() })).toEqual({
      text: "Completed",
      role: "neutral",
    });
    expect(
      containerStatus({
        ready: false,
        state: terminated({ exitCode: 1, reason: "Error" }),
      })
    ).toEqual({ text: "Error", role: "err" });
    expect(
      containerStatus({
        ready: false,
        state: terminated({ exitCode: 137, reason: "OOMKilled", signal: 9 }),
      })
    ).toEqual({ text: "OOMKilled", role: "err" });
  });

  it("does not claim to know a state the runtime did not report", () => {
    expect(
      containerStatus({ ready: false, state: { type: "unknown" } })
    ).toEqual({ text: "Unknown", role: "warn" });
  });
});
