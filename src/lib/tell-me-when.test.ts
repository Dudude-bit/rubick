import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CustomResourceInfo,
  DeploymentInfo,
  JobInfo,
  PodInfo,
} from "@/generated/types";
import { Coalescer, judge, type Verdict, type Watch } from "./tell-me-when";

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
