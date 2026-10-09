import { describe, expect, it } from "vite-plus/test";

import { containerStatus, describeRestarts } from "./pod-status";
import type { ContainerState, TerminationInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

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

describe("describeRestarts", () => {
  const t: T = (section, key, values) => translate("en", section, key, values);
  const ru: T = (section, key, values) => translate("ru", section, key, values);
  const initDemo = {
    restartCount: 15,
    lastRestartAt: "2026-10-09T14:00:00Z",
    restartsBy: [
      { container: "wait-for-db", n: 5 },
      { container: "migrate", n: 10 },
    ],
  };

  /**
   * Sam's init-demo page said "10 restarts so far" for migrate and "15
   * restarts" in its Restarts row, five of them wait-for-db's, which had
   * finished fine, with nothing saying whose. Fails if a count more than one
   * container makes does not name them, or one container's count is split.
   */
  it("names the containers behind a count more than one of them makes", () => {
    expect(describeRestarts(initDemo, t, "3m")).toBe(
      "15 restarts, last 3m ago: wait-for-db 5, migrate 10"
    );
    expect(describeRestarts(initDemo, ru, "3 мин")).toBe(
      "15 перезапусков, последний 3 мин назад: wait-for-db 5, migrate 10"
    );
    expect(
      describeRestarts(
        { ...initDemo, restartsBy: [{ container: "migrate", n: 15 }] },
        t,
        "3m"
      )
    ).toBe("15 restarts, last 3m ago");
  });
});
