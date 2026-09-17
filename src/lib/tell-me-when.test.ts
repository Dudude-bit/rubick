import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CustomResourceInfo,
  DaemonSetInfo,
  DeploymentInfo,
  JobInfo,
  PodInfo,
  StatefulSetInfo,
} from "@/generated/types";
import {
  Coalescer,
  judge,
  SAYS_TONE,
  type Says,
  type Verdict,
  type Watch,
} from "./tell-me-when";

function watchOn(kind: Watch["kind"], ask: Watch["ask"]): Watch {
  return {
    id: "w1",
    context: "prod",
    kind,
    namespace: "shop",
    name: "payments",
    ask,
    startedAt: 0,
    status: { state: "watching" },
    baseline: null,
  };
}

function deployment(
  replicas: Partial<DeploymentInfo["replicas"]>,
  progressing?: { status: string; reason?: string; message?: string }
): DeploymentInfo {
  return {
    replicas: { desired: 3, ready: 3, available: 3, updated: 3, ...replicas },
    conditions: progressing
      ? [
          {
            type: "Progressing",
            status: progressing.status,
            reason: progressing.reason ?? null,
            message: progressing.message ?? null,
            lastTransitionTime: null,
          },
        ]
      : [],
  } as DeploymentInfo;
}

/** Feeds looks the way the hook does: baseline carried forward, and the first verdict is the last look. */
function walk(watch: Watch, looks: unknown[]): Verdict[] {
  let current = watch;
  for (const look of looks) {
    const { verdict, baseline } = judge(current, "applied", look);
    current = { ...current, baseline };
    if (verdict) return [verdict];
  }
  return [];
}

describe("a rollout", () => {
  /** Answering on the first look would say "rolled out" to someone who just clicked on a settled deployment. */
  it("answers once, after it has seen the rollout move", () => {
    const looks = [
      deployment({}),
      ...Array.from({ length: 20 }, (_, i) =>
        deployment({ updated: 1 + (i % 3), available: 2, ready: 2 })
      ),
      deployment({}, { status: "True", reason: "NewReplicaSetAvailable" }),
    ];
    expect(looks).toHaveLength(22);
    expect(walk(watchOn("Deployment", "rollout"), looks)).toEqual([
      { says: "rolledOut", detail: null },
    ]);
  });

  it("carries the controller's words when it gives up", () => {
    const looks = [
      deployment({ updated: 1 }),
      deployment(
        { updated: 1 },
        {
          status: "False",
          reason: "ProgressDeadlineExceeded",
          message: 'ReplicaSet "payments-7d9" has timed out progressing.',
        }
      ),
    ];
    expect(walk(watchOn("Deployment", "rollout"), looks)).toEqual([
      {
        says: "rolloutFailed",
        detail: 'ReplicaSet "payments-7d9" has timed out progressing.',
      },
    ]);
  });

  it("says gone when the object is deleted under it", () => {
    expect(
      judge(watchOn("Deployment", "rollout"), "deleted", null).verdict
    ).toEqual({ says: "gone", detail: null });
  });
});

function pod(ready: boolean, restarts: number, display = "Running"): PodInfo {
  return {
    restartCount: restarts,
    status: { ready, display, message: null, reason: null },
  } as PodInfo;
}

describe("a pod", () => {
  it("says ready once a pod that was not comes up", () => {
    expect(
      walk(watchOn("Pod", "podReady"), [
        pod(false, 0),
        pod(false, 0),
        pod(true, 0),
        pod(true, 0),
      ])
    ).toEqual([{ says: "ready", detail: null }]);
  });

  /** A pod that was already Ready has nothing to come up from; the question is whether it stays. */
  it("says nothing about a pod that was ready all along, until it restarts", () => {
    expect(
      walk(watchOn("Pod", "podReady"), [
        pod(true, 2),
        pod(true, 2),
        pod(false, 3, "CrashLoopBackOff"),
      ])
    ).toEqual([{ says: "crashedAgain", detail: "CrashLoopBackOff" }]);
  });

  /** A crash phase is an answer even when the restart count has not moved yet — the phase is the second half of the OR. Fails if the CRASHED.has clause is dropped. */
  it("says crashed on a crash phase alone, before the restart count moves", () => {
    expect(
      walk(watchOn("Pod", "podReady"), [
        pod(true, 2, "Running"),
        pod(true, 2, "OOMKilled"),
      ])
    ).toEqual([{ says: "crashedAgain", detail: "OOMKilled" }]);
  });
});

function statefulSet(
  ready: number,
  current: number,
  desired = 3
): StatefulSetInfo {
  return { replicas: { desired, ready, current } } as StatefulSetInfo;
}

function daemonSet(ready: number, current: number, desired = 3): DaemonSetInfo {
  return { desired, current, ready } as DaemonSetInfo;
}

describe("a statefulset or daemonset", () => {
  /** rolloutOf settles these two on their own replica fields, separate code from the Deployment arm. Fails if the StatefulSet arm stops settling. */
  it("says rolled out once a statefulset reaches its desired replicas", () => {
    expect(
      walk(watchOn("StatefulSet", "rollout"), [
        statefulSet(1, 1),
        statefulSet(3, 3),
      ])
    ).toEqual([{ says: "rolledOut", detail: null }]);
  });

  /** Fails if the DaemonSet arm stops settling. */
  it("says rolled out once a daemonset reaches its desired count", () => {
    expect(
      walk(watchOn("DaemonSet", "rollout"), [daemonSet(1, 1), daemonSet(3, 3)])
    ).toEqual([{ says: "rolledOut", detail: null }]);
  });
});

describe("a job", () => {
  it("answers as soon as it is over, even on the first look", () => {
    expect(
      walk(watchOn("Job", "jobOutcome"), [{ status: "Failed" } as JobInfo])
    ).toEqual([{ says: "failed", detail: null }]);
    expect(
      walk(watchOn("Job", "jobOutcome"), [
        { status: "Running" } as JobInfo,
        { status: "Complete" } as JobInfo,
      ])
    ).toEqual([{ says: "succeeded", detail: null }]);
  });
});

function certificate(
  notAfter: string,
  revision: number,
  ready = "True"
): CustomResourceInfo {
  return {
    annotations: { "cert-manager.io/certificate-revision": String(revision) },
    status: { notAfter, conditions: [{ type: "Ready", status: ready }] },
  } as unknown as CustomResourceInfo;
}

describe("a certificate", () => {
  it("says renewed when the expiry moves out and the certificate is Ready", () => {
    expect(
      walk(watchOn("Certificate", "renewed"), [
        certificate("2026-10-01T00:00:00Z", 3),
        certificate("2026-10-01T00:00:00Z", 3),
        certificate("2026-10-01T00:00:00Z", 4, "False"),
        certificate("2026-12-30T00:00:00Z", 4),
      ])
    ).toEqual([{ says: "renewed", detail: "2026-12-30T00:00:00Z" }]);
  });

  /** Issuance failing is its own verdict, distinct from renewed, carrying the controller's words. Fails if that branch is dropped. */
  it("says issuance failed when Issuing goes False with a message and the expiry has not moved", () => {
    const failing = {
      annotations: { "cert-manager.io/certificate-revision": "3" },
      status: {
        notAfter: "2026-10-01T00:00:00Z",
        conditions: [
          { type: "Ready", status: "False" },
          {
            type: "Issuing",
            status: "False",
            message: "order errored: 429 rate limited",
          },
        ],
      },
    } as unknown as CustomResourceInfo;
    expect(
      walk(watchOn("Certificate", "renewed"), [
        certificate("2026-10-01T00:00:00Z", 3),
        failing,
      ])
    ).toEqual([
      { says: "issuanceFailed", detail: "order errored: 429 rate limited" },
    ]);
  });
});

describe("coalescing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Three pods coming up in the same second are one event to the person, not three notifications. */
  it("sends what arrived within the window as one batch", () => {
    const flush = vi.fn();
    const c = new Coalescer<string>(flush, 10_000);
    c.push("a");
    vi.advanceTimersByTime(4_000);
    c.push("b");
    vi.advanceTimersByTime(5_000);
    c.push("c");
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(["a", "b", "c"]);
    c.push("d");
    vi.advanceTimersByTime(10_000);
    expect(flush).toHaveBeenLastCalledWith(["d"]);
  });
});

describe("the tone a verdict is shown in", () => {
  const failures: Says[] = [
    "rolloutFailed",
    "crashedAgain",
    "failed",
    "drainFailed",
    "issuanceFailed",
    "forwardDied",
  ];
  const notFailures: Says[] = [
    "rolledOut",
    "ready",
    "succeeded",
    "drained",
    "drainStopped",
    "drainCancelled",
    "renewed",
    "gone",
    "lostSight",
    // An action that ran out of time may well have worked; the app only
    // stopped being able to say.
    "timedOut",
  ];

  /** The third-state rule on the dot: an ending that is not a failure must never wear the failure tone. Fails if a non-failure verdict is mapped to bg-err again (the fallback that painted `gone` red). */
  it.each(notFailures)("does not paint %s with the failure tone", (says) => {
    expect(SAYS_TONE[says]).not.toBe("bg-err");
  });

  it.each(failures)("paints %s with the failure tone", (says) => {
    expect(SAYS_TONE[says]).toBe("bg-err");
  });
});

describe("an action being followed", () => {
  const after = (
    action: "restart" | "scale" | "apply" | "image",
    replicas: number | null = null,
    generationBefore: number | null = 4
  ) => ({
    ...watchOn("Deployment", "rollout"),
    after: { action, replicas, generationBefore },
    deadline: 120_000,
  });
  const look = (
    generation: number,
    observed: number,
    replicas: Partial<DeploymentInfo["replicas"]> = {},
    revision = "8"
  ): DeploymentInfo => ({
    ...deployment(replicas),
    generation,
    observedGeneration: observed,
    annotations: { "deployment.kubernetes.io/revision": revision },
  });

  /**
   * The Deployment looked fine before the click and looks fine for a
   * second after it. Saying "rolled out" on that second is the lie this
   * exists to avoid: nothing is said until the generation moved past the
   * one the page saw before the click.
   */
  it("says nothing on a settled look whose generation is the one before the click", () => {
    expect(walk(after("restart"), [look(4, 4), look(4, 4)])).toEqual([]);
  });

  it("says rolled out only once the new generation is observed and settled", () => {
    expect(
      walk(after("restart"), [
        look(4, 4),
        look(5, 4, { updated: 1, ready: 2 }),
        look(5, 5, { updated: 3, ready: 3 }, "9"),
      ])
    ).toEqual([
      {
        says: "rolledOut",
        detail: {
          key: "rolloutSeenRevision",
          values: { ready: 3, desired: 3, revision: "9" },
        },
      },
    ]);
  });

  it("acknowledges a scale by the count asked for, not by a generation the page did not know", () => {
    expect(
      walk(after("scale", 5, null), [
        look(4, 4, { desired: 3 }),
        look(5, 5, { desired: 5, ready: 3, updated: 5, available: 3 }),
        look(5, 5, { desired: 5, ready: 5, updated: 5, available: 5 }),
      ])
    ).toEqual([
      {
        says: "rolledOut",
        detail: {
          key: "rolloutSeenRevision",
          values: { ready: 5, desired: 5, revision: "8" },
        },
      },
    ]);
  });

  it("carries the controller's words when the rollout it follows gives up", () => {
    expect(
      walk(after("image"), [
        look(4, 4),
        {
          ...look(5, 5, { updated: 1, ready: 2 }),
          conditions: [
            {
              type: "Progressing",
              status: "False",
              reason: "ProgressDeadlineExceeded",
              message: "ReplicaSet has timed out progressing.",
              lastTransitionTime: null,
            },
          ],
        },
      ])
    ).toEqual([
      {
        says: "rolloutFailed",
        detail: "ReplicaSet has timed out progressing.",
      },
    ]);
  });

  /**
   * The apiserver bumps `generation` the moment the action lands, while the
   * status still describes the rollout before it. A Deployment already stuck
   * with `Progressing=False` therefore answered "failed" within a second of
   * the click — with the *previous* revision's message — and the watch then
   * closed, so the fix it was following could never report success. The
   * success arm had refused a stale "yes" all along; this is the same
   * suspicion applied to a "no".
   */
  it("does not read a failure the reader's action cannot have caused", () => {
    const asked = 1_700_000_100_000;
    const stuck = (at: string | null) => ({
      ...look(8, 7, { updated: 1, ready: 2 }),
      conditions: [
        {
          type: "Progressing",
          status: "False",
          reason: "ProgressDeadlineExceeded",
          message: "the previous rollout timed out.",
          lastTransitionTime: at,
        },
      ],
    });
    const watch = {
      ...after("image", null, 7),
      after: {
        action: "image" as const,
        replicas: null,
        generationBefore: 7,
        askedAt: asked,
      },
    };

    // Stamped a minute before the click: somebody else's rollout.
    expect(
      walk(watch, [stuck(new Date(asked - 60_000).toISOString())])
    ).toEqual([]);

    // Stamped after it: this one, and it is the reader's to hear about.
    expect(walk(watch, [stuck(new Date(asked + 1_000).toISOString())])).toEqual(
      [{ says: "rolloutFailed", detail: "the previous rollout timed out." }]
    );
  });

  /**
   * `generation` moves the instant the apiserver accepts the write, but the
   * replica counts still describe the rollout before it — so the first look
   * after a click is the *old* rollout, complete and settled, wearing the new
   * generation. Answering "rolled out" there reports the state the reader was
   * trying to leave. Fails if the `observedGeneration` half of the success
   * arm is dropped.
   */
  it("says nothing while the controller has not looked at the generation yet", () => {
    expect(
      walk(after("image"), [
        look(4, 4),
        look(5, 4, {}, "8"),
        look(5, 5, {}, "9"),
      ])
    ).toEqual([
      {
        says: "rolledOut",
        detail: {
          key: "rolloutSeenRevision",
          values: { ready: 3, desired: 3, revision: "9" },
        },
      },
    ]);
  });

  /**
   * Same suspicion on the failure arm, where the cluster left no stamp to
   * settle it: an unobserved generation means the `Progressing=False` on
   * screen is about the rollout before the click. Fails if the fallback
   * stops asking whether the controller has caught up.
   */
  it("holds a failure with no stamp until the controller has looked", () => {
    const stuck = (observed: number, message: string) => ({
      ...look(8, observed, { updated: 1, ready: 2 }),
      conditions: [
        {
          type: "Progressing",
          status: "False",
          reason: "ProgressDeadlineExceeded",
          message,
          lastTransitionTime: null,
        },
      ],
    });
    expect(
      walk(after("image", null, 7), [
        stuck(7, "the rollout before the click timed out."),
        stuck(8, "this rollout timed out."),
      ])
    ).toEqual([{ says: "rolloutFailed", detail: "this rollout timed out." }]);
  });

  /**
   * `detail` is documented as "the cluster's own words", and for a rollout
   * it was ours: `seenWords` built "3 of 3 ready, revision 8" in English at
   * judge time, and both readers — the Watching tab and the desktop
   * notification — printed it to a Russian reader as it was. A key survives
   * the trip and becomes words where the translator is.
   */
  it("carries its own sentence as a key and the cluster's as a string", () => {
    const [ours] = walk(after("restart"), [look(4, 4), look(5, 5, {}, "9")]);
    expect(typeof ours.detail).toBe("object");

    const [theirs] = walk(after("image"), [
      look(4, 4),
      {
        ...look(5, 5, { updated: 1, ready: 2 }),
        conditions: [
          {
            type: "Progressing",
            status: "False",
            reason: "ProgressDeadlineExceeded",
            message: "ReplicaSet has timed out progressing.",
            lastTransitionTime: null,
          },
        ],
      },
    ]);
    expect(theirs.detail).toBe("ReplicaSet has timed out progressing.");
  });

  it("remembers the last look in words, for the timeout to say", () => {
    let current = after("restart");
    for (const l of [look(4, 4), look(5, 4, { updated: 1, ready: 2 })]) {
      current = { ...current, baseline: judge(current, "applied", l).baseline };
    }
    expect(current.baseline?.seen).toEqual({
      key: "rolloutSeenRevision",
      values: { ready: 2, desired: 3, revision: "8" },
    });
  });
});
