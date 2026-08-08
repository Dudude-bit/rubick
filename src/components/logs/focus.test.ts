import { describe, expect, it } from "vitest";

import type { ContainerInfo, TerminationInfo } from "@/generated/types";
import { initialFocus } from "./focus";

function termination(
  overrides: Partial<TerminationInfo> = {}
): TerminationInfo {
  return {
    exitCode: 0,
    signal: null,
    reason: "Completed",
    message: null,
    startedAt: "2026-08-08T12:45:38Z",
    finishedAt: "2026-08-08T12:45:42Z",
    ...overrides,
  };
}

function container(
  name: string,
  overrides: Partial<ContainerInfo> = {}
): ContainerInfo {
  return {
    name,
    image: "busybox:1.36",
    ready: false,
    phase: "app",
    state: { type: "running" },
    lastTerminated: null,
    restartCount: 0,
    ports: [],
    env: [],
    envFrom: [],
    ...overrides,
  };
}

const migrate = container("migrate", {
  phase: "init",
  state: { type: "waiting", reason: "CrashLoopBackOff" },
  lastTerminated: termination({ exitCode: 1, reason: "Error" }),
  restartCount: 9,
});

const stuckInInit = [
  container("wait-for-db", {
    phase: "init",
    state: { type: "terminated", termination: termination() },
  }),
  migrate,
  container("seed", {
    phase: "init",
    state: { type: "waiting", reason: "PodInitializing" },
  }),
  container("app", { state: { type: "waiting", reason: "PodInitializing" } }),
];

/**
 * Opening Logs on a pod in `Init:CrashLoopBackOff` used to show an empty
 * pane: the app container has never started, and the one log that
 * answers the question belongs to a container the viewer did not know
 * existed, on a run it could not ask for.
 */
describe("initialFocus on a pod held in init", () => {
  const focus = initialFocus(stuckInInit);

  it("opens on the init container that is failing, alone", () => {
    expect([...focus.hidden].sort()).toEqual(["app", "seed", "wait-for-db"]);
    expect(focus.reason).toEqual({
      kind: "failing-init",
      container: "migrate",
      previous: true,
    });
  });

  it("opens on the run that printed the reason, not the one backing off", () => {
    // A crash-looping container is *waiting*: its current run has printed
    // nothing and may not have started. The reason is in the run before.
    expect(focus.previous).toBe(true);
  });

  it("reads the current run when the failed container is still sitting on it", () => {
    // Terminated rather than waiting — nothing has restarted, so
    // `--previous` would reach past the output that matters.
    const terminated = initialFocus([
      container("migrate", {
        phase: "init",
        state: {
          type: "terminated",
          termination: termination({ exitCode: 1, reason: "Error" }),
        },
      }),
      container("app", {
        state: { type: "waiting", reason: "PodInitializing" },
      }),
    ]);
    expect(terminated.previous).toBe(false);
    expect([...terminated.hidden]).toEqual(["app"]);
  });
});

/**
 * An init container's lines are minutes older than everything else in
 * the buffer. Interleaved they sit at the very top and never move, and
 * the newest thing they say is older than the oldest app line.
 */
describe("initialFocus on a running pod that ran init containers", () => {
  it("holds the finished init logs out and says which", () => {
    const focus = initialFocus([
      container("prepare", {
        phase: "init",
        state: { type: "terminated", termination: termination() },
      }),
      container("proxy", { phase: "sidecar", ready: true }),
      container("app", { ready: true }),
    ]);

    expect([...focus.hidden]).toEqual(["prepare"]);
    // A sidecar runs alongside the app containers, so its lines belong
    // in the same timeline and are not held out.
    expect(focus.reason).toEqual({
      kind: "phase-split",
      containers: ["prepare"],
    });
    expect(focus.previous).toBe(false);
  });

  it("hides nothing on a pod with no init containers at all", () => {
    const focus = initialFocus([
      container("app", { ready: true }),
      container("envoy", { ready: true }),
    ]);
    expect(focus.hidden.size).toBe(0);
    expect(focus.reason).toBeNull();
  });
});

/**
 * A container asked for by name from the Containers tab. Which
 * containers are shown is visible in the legend; which run is not
 * visible anywhere, so that is the only thing worth a sentence.
 */
describe("initialFocus with a container asked for by name", () => {
  it("solos it and says so only when the run is not the current one", () => {
    const asked = initialFocus(stuckInInit, "migrate");
    expect([...asked.hidden].sort()).toEqual(["app", "seed", "wait-for-db"]);
    expect(asked.previous).toBe(true);
    expect(asked.reason).toEqual({
      kind: "previous-run",
      container: "migrate",
    });

    const healthy = initialFocus(stuckInInit, "wait-for-db");
    expect(healthy.previous).toBe(false);
    expect(healthy.reason).toBeNull();
  });

  it("falls back to deciding for itself when the name is not in the pod", () => {
    expect(initialFocus(stuckInInit, "gone").reason).toEqual({
      kind: "failing-init",
      container: "migrate",
      previous: true,
    });
  });
});
