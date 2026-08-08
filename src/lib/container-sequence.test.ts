import { describe, expect, it } from "vitest";

import type {
  ContainerInfo,
  DeploymentContainerInfo,
  TerminationInfo,
} from "@/generated/types";
import {
  containerSequence,
  declaredContainers,
  podContainers,
  podPorts,
  podReadiness,
  shellTargets,
  templateSequence,
} from "./container-sequence";

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

function declared(
  name: string,
  overrides: Partial<DeploymentContainerInfo> = {}
): DeploymentContainerInfo {
  return {
    name,
    image: "busybox:1.36",
    phase: "app",
    ports: [],
    resources: { requests: {}, limits: {} },
    env: [],
    envFrom: [],
    ...overrides,
  };
}

/**
 * The `meshed-demo` specimen's template: an ordinary init container, a
 * native sidecar, and the app container. All five kinds that share
 * `DeploymentContainerInfo` showed only `app` before this.
 */
const meshedTemplate = {
  initContainers: [
    declared("wait-for-config", { phase: "init" as const }),
    declared("proxy", { phase: "sidecar" as const }),
  ],
  containers: [declared("app")],
};

describe("templateSequence", () => {
  it("groups a template the way the pod's Containers tab groups a run", () => {
    expect(
      templateSequence(meshedTemplate).map((group) => [
        group.phase,
        group.containers.map((c) => c.name),
      ])
    ).toEqual([
      ["init", ["wait-for-config"]],
      ["sidecar", ["proxy"]],
      ["app", ["app"]],
    ]);
  });

  it("says what will happen rather than what has, because nothing has", () => {
    // A template is a declaration. "started during init and still
    // running" is a claim about a process, and there is no process — it
    // would be the same lie as calling a queued container failed.
    const captions = templateSequence(meshedTemplate).map((g) => g.caption);
    expect(captions).toEqual([
      "run in order before each pod starts, each waiting on the last",
      "start during init and run for the life of each pod",
      "run together for the life of each pod",
    ]);
  });

  it("leaves an ordinary template as one group, with no sequence to draw", () => {
    // The common case, and it must not grow a rail: spec order between
    // two app containers says nothing, unlike between two init ones.
    expect(templateSequence({ containers: [declared("app")] })).toHaveLength(1);
  });
});

describe("declaredContainers", () => {
  it("carries a template's init containers, which five detail pages dropped", () => {
    expect(declaredContainers(meshedTemplate).map((c) => c.name)).toEqual([
      "wait-for-config",
      "proxy",
      "app",
    ]);
  });
});

/**
 * The `sidecar-demo` specimen, exactly as the cluster reports it: a
 * finished ordinary init container, a running sidecar, a running app
 * container. `kubectl get pod sidecar-demo` says `2/2`.
 *
 * `prepare` carrying `ready: true` is not a mistake in this fixture — the
 * kubelet really does leave it set on an init container that exited 0,
 * and it is the whole reason a tally over both lists reads `3/3`.
 */
const meshedPod = {
  initContainers: [
    container("prepare", {
      phase: "init" as const,
      ready: true,
      state: { type: "terminated" as const, termination: termination() },
    }),
    container("proxy", {
      phase: "sidecar" as const,
      ready: true,
      ports: [{ name: "proxy", containerPort: 15001, protocol: "TCP" }],
    }),
  ],
  containers: [
    container("app", {
      ready: true,
      ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
    }),
  ],
};

describe("podReadiness", () => {
  it("counts a sidecar in both halves and an ordinary init container in neither", () => {
    // Verified against `kubectl get pod -n k8s-gui-test`, which reports
    // this pod 2/2. Reading `.containers` alone says 1/1; adding every
    // init container says 3/3; both are wrong in the same window.
    expect(podReadiness(meshedPod)).toEqual({
      ready: 2,
      total: 2,
      allReady: true,
    });
  });

  it("keeps the sidecar in the denominator when it is the thing that is down", () => {
    expect(
      podReadiness({
        ...meshedPod,
        initContainers: [
          meshedPod.initContainers[0],
          container("proxy", {
            phase: "sidecar",
            state: { type: "waiting", reason: "CrashLoopBackOff" },
            lastTerminated: termination({ exitCode: 1 }),
          }),
        ],
      })
    ).toEqual({ ready: 1, total: 2, allReady: false });
  });

  it("reports 0 of 1 for a pod stuck in init, as kubectl does", () => {
    // `init-demo`: `Init:CrashLoopBackOff`, nothing running, `0/1`.
    expect(
      podReadiness({
        initContainers: stuckInInit.slice(0, 3),
        containers: [stuckInInit[3]],
      })
    ).toEqual({ ready: 0, total: 1, allReady: false });
  });

  it("does not count a container that is ready but no longer running", () => {
    // kubectl's numerator is `Ready && Running`; a job pod whose container
    // has exited is `0/1` however its last `ready` was left.
    expect(
      podReadiness({
        containers: [
          container("app", {
            ready: true,
            state: { type: "terminated", termination: termination() },
          }),
        ],
      }).ready
    ).toBe(0);
  });

  it("cannot be handed one of the two lists", () => {
    // The guard, and the reason it is here rather than in a comment: this
    // line is a type error, `tsc --noEmit` is a gate, and an unused
    // `@ts-expect-error` fails just as loudly. Widening `podReadiness` to
    // take a `ContainerInfo[]` — which is how every one of these call
    // sites was wrong in the first place — breaks the build.
    // @ts-expect-error a pod's containers are not a pod
    expect(() => podReadiness(meshedPod.containers)).toThrow();
  });
});

describe("podPorts", () => {
  it("offers the sidecar's port, and the app's first", () => {
    expect(
      podPorts(meshedPod).map(({ container: c, port }) => [
        c.name,
        port.containerPort,
      ])
    ).toEqual([
      ["app", 8080],
      ["proxy", 15001],
    ]);
  });

  it("leaves out a port declared by an ordinary init container", () => {
    // It has exited. Nothing is listening on it, and a forward to it fails.
    expect(
      podPorts({
        initContainers: [
          container("prepare", {
            phase: "init",
            state: { type: "terminated", termination: termination() },
            ports: [{ name: null, containerPort: 9999, protocol: "TCP" }],
          }),
        ],
        containers: [meshedPod.containers[0]],
      }).map(({ port }) => port.containerPort)
    ).toEqual([8080]);
  });
});

describe("shellTargets", () => {
  it("can reach a sidecar, and reaches the app container first", () => {
    expect(shellTargets(meshedPod).map((c) => c.name)).toEqual([
      "app",
      "proxy",
    ]);
  });

  it("does not make a finished init container look attachable", () => {
    expect(shellTargets(meshedPod).map((c) => c.name)).not.toContain("prepare");
  });

  it("falls to the sidecar when it is the only live process left", () => {
    expect(
      shellTargets({
        ...meshedPod,
        containers: [
          container("app", {
            state: { type: "waiting", reason: "CrashLoopBackOff" },
            lastTerminated: termination({ exitCode: 1 }),
          }),
        ],
      }).map((c) => c.name)
    ).toEqual(["proxy"]);
  });

  it("offers an init container that is running right now", () => {
    // A long migration is the one shell in the pod worth having, and it is
    // liveness that decides this, not which list the container came from.
    expect(
      shellTargets({
        initContainers: [container("migrate", { phase: "init" })],
        containers: [
          container("app", { state: { type: "waiting", reason: null } }),
        ],
      }).map((c) => c.name)
    ).toEqual(["migrate"]);
  });
});
