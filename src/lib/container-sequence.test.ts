import { describe, expect, it } from "vitest";

import type { ContainerInfo, TerminationInfo } from "@/generated/types";
import { containerSequence, podContainers } from "./container-sequence";

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

/** The `init-demo` specimen: wait-for-db ok, migrate looping, seed queued. */
const stuckInInit = [
  container("wait-for-db", {
    phase: "init",
    state: { type: "terminated", termination: termination() },
  }),
  container("migrate", {
    phase: "init",
    state: { type: "waiting", reason: "CrashLoopBackOff" },
    lastTerminated: termination({ exitCode: 1, reason: "Error" }),
    restartCount: 9,
  }),
  container("seed", {
    phase: "init",
    state: { type: "waiting", reason: "PodInitializing" },
  }),
  container("app", { state: { type: "waiting", reason: "PodInitializing" } }),
];

/**
 * A container that never got a turn and a container that crashed are not
 * the same thing, and a flat list of three states said "waiting" for
 * both. `seed` did not fail — the step before it did, and it is the
 * position in the sequence, not any field on `seed` itself, that says so.
 */
describe("containerSequence on a pod held in init", () => {
  it("marks the step that failed and the step that never got a turn apart", () => {
    const groups = containerSequence(stuckInInit);
    const init = groups.find((group) => group.phase === "init")!;

    expect(init.steps.map((step) => [step.container.name, step.mark])).toEqual([
      ["wait-for-db", "done"],
      ["migrate", "failed"],
      ["seed", "queued"],
    ]);
  });

  it("names what a queued step is waiting on, which is not itself", () => {
    const groups = containerSequence(stuckInInit);
    const seed = groups
      .find((group) => group.phase === "init")!
      .steps.find((step) => step.container.name === "seed")!;

    expect(seed.note).toBe("Never ran — the sequence is still on migrate.");
    // "PodInitializing" is the kubelet saying "not your turn"; printed as
    // the status it reads as a container that is coming up.
    expect(seed.status.text).toBe("Never started");
  });

  it("does not let an app container claim it is starting while init is stuck", () => {
    const groups = containerSequence(stuckInInit);
    const app = groups.find((group) => group.phase === "app")!;

    expect(app.caption).toContain("never started");
    expect(app.steps[0].note).toBe("No logs yet — init has not finished.");
  });

  it("keeps the failed step's restart history pointing at the log", () => {
    const groups = containerSequence(stuckInInit);
    const migrate = groups
      .find((group) => group.phase === "init")!
      .steps.find((step) => step.container.name === "migrate")!;

    expect(migrate.note).toContain("9 attempts");
    expect(migrate.note).toContain("in Logs");
  });
});

/**
 * A sidecar is an init container that never finishes. Grouped with the
 * init sequence it would read as a completed step; grouped with the app
 * containers it would read as having started with them.
 */
describe("containerSequence with a sidecar", () => {
  const groups = containerSequence([
    container("prepare", {
      phase: "init",
      state: { type: "terminated", termination: termination() },
    }),
    container("proxy", { phase: "sidecar", ready: true }),
    container("app", { ready: true }),
  ]);

  it("puts the sidecar in a group of its own, between init and the app", () => {
    expect(groups.map((group) => group.phase)).toEqual([
      "init",
      "sidecar",
      "app",
    ]);
    expect(groups[1].steps.map((step) => step.container.name)).toEqual([
      "proxy",
    ]);
  });

  it("says a finished init container's log is complete, not quiet", () => {
    // Otherwise it is indistinguishable from a live container saying
    // nothing, down to Follow sitting there doing nothing.
    expect(groups[0].steps[0].note).toMatch(
      /^Finished in 4s, .+ ago — its log is complete\.$/
    );
  });

  it("lets the app group say the pod actually started", () => {
    expect(groups[2].caption).toBe("run together for the life of the pod");
  });
});

/**
 * The order is the payload. A viewer handed only `.containers` is the
 * bug this whole piece exists to fix, and concatenating the other way
 * round would put the app container before the steps it waited on.
 */
describe("podContainers", () => {
  it("puts init containers first, in run order", () => {
    expect(
      podContainers({
        initContainers: [container("wait-for-db"), container("migrate")],
        containers: [container("app")],
      }).map((c) => c.name)
    ).toEqual(["wait-for-db", "migrate", "app"]);
  });
});
