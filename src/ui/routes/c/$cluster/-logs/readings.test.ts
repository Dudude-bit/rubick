import { describe, expect, it } from "vite-plus/test";

import type { ContainerInfo } from "@/generated/types";

import {
  countReadings,
  readingOf,
  readLanes,
  worstReading,
  type HowRead,
} from "./readings";

const container = (overrides: Partial<ContainerInfo> = {}): ContainerInfo => ({
  name: "app",
  image: "busybox",
  ready: true,
  started: true,
  phase: "app",
  state: { type: "running" },
  lastTerminated: null,
  restartCount: 0,
  ports: [],
  env: [],
  resources: { requests: {}, limits: {} },
  envFrom: [],
  ...overrides,
});

const exited = (exitCode: number): ContainerInfo["state"] => ({
  type: "terminated",
  termination: {
    exitCode,
    signal: null,
    reason: exitCode === 0 ? "Completed" : "Error",
    message: null,
    startedAt: null,
    finishedAt: null,
  },
});

const backoff = container({
  state: { type: "waiting", reason: "CrashLoopBackOff" },
  lastTerminated: {
    exitCode: 1,
    signal: null,
    reason: "Error",
    message: null,
    startedAt: null,
    finishedAt: null,
  },
  restartCount: 9,
});
const neverRun = container({
  state: { type: "waiting", reason: "ImagePullBackOff" },
});

const followed: HowRead = { previous: false, restartsAlways: false };
const deployment: HowRead = { previous: false, restartsAlways: true };
const gone = { kind: "gone" } as const;

describe("what one stream is doing", () => {
  it("is streaming while nothing stopped it, and read when the run was one that is over", () => {
    expect(readingOf(undefined, container(), followed)).toBe("streaming");
    expect(
      readingOf(undefined, container(), { ...followed, previous: true })
    ).toBe("read");
  });

  /**
   * Sam's shop/recommendations: one container in back-off, read fine. Fails
   * if a stream that ended over a container that will start again is
   * called unreadable, or finished.
   */
  it("calls a followed run that ended over a container on its way back restarting", () => {
    expect(readingOf(gone, backoff, followed)).toBe("restarting");
    expect(readingOf(gone, container({ state: exited(1) }), deployment)).toBe(
      "restarting"
    );
    expect(
      readingOf(
        gone,
        container({ state: exited(1), restartCount: 3 }),
        followed
      )
    ).toBe("restarting");
    expect(readingOf(gone, container({ restartCount: 3 }), followed)).toBe(
      "restarting"
    );
    expect(readingOf(gone, container(), deployment)).toBe("restarting");
  });

  /**
   * A Job's pod that finished, an init container that ran, and a pod list
   * that has not yet caught up with an exit are not coming back.
   */
  it("calls a followed run that ended over a container that is done ended", () => {
    expect(readingOf(gone, container({ state: exited(0) }), followed)).toBe(
      "ended"
    );
    expect(
      readingOf(
        gone,
        container({ phase: "init", state: exited(0) }),
        deployment
      )
    ).toBe("ended");
    expect(
      readingOf(
        gone,
        container({ state: exited(0), restartCount: 2 }),
        followed
      )
    ).toBe("ended");
    expect(readingOf(gone, container(), followed)).toBe("ended");
    expect(readingOf(gone, neverRun, followed)).toBe("ended");
    expect(readingOf(gone, undefined, deployment)).toBe("ended");
    expect(
      readingOf(gone, container({ state: { type: "unknown" } }), deployment)
    ).toBe("ended");
  });

  it("tells a container that never started from a stream that broke", () => {
    expect(readingOf({ kind: "broken" }, neverRun, followed)).toBe(
      "notStarted"
    );
    expect(readingOf({ kind: "broken" }, backoff, followed)).toBe("lost");
    expect(readingOf({ kind: "broken" }, container(), followed)).toBe("lost");
    expect(readingOf({ kind: "broken" }, undefined, followed)).toBe("lost");
  });

  it("keeps the node's give-up, a dropped log and a missing earlier run apart", () => {
    expect(readingOf({ kind: "follow-stopped" }, container(), followed)).toBe(
      "notFollowed"
    );
    expect(readingOf({ kind: "log-not-kept" }, container(), followed)).toBe(
      "notKept"
    );
    expect(readingOf({ kind: "no-previous-run" }, container(), followed)).toBe(
      "absent"
    );
  });
});

describe("what a pod of several streams is doing", () => {
  it("is the least trustworthy thing any of its streams says", () => {
    expect(worstReading(["streaming", "lost", "ended"])).toBe("lost");
    expect(worstReading(["streaming", "notFollowed"])).toBe("notFollowed");
    expect(worstReading(["streaming", "restarting"])).toBe("restarting");
    expect(worstReading(["streaming", "notStarted"])).toBe("notStarted");
    expect(worstReading([])).toBeNull();
  });

  /** An init container's end is the ordinary start of a Deployment's pod. */
  it("reads a pod whose init container ended and whose app streams as streaming", () => {
    expect(worstReading(["ended", "streaming"])).toBe("streaming");
    expect(worstReading(["read", "absent"])).toBe("read");
  });

  /**
   * Sam's log-demo: three of a pod's five containers were not followed and
   * two were. One pod, one reading, and another pod's failure of a container
   * with the same name is not its own.
   */
  it("reads each pod once, from its own containers' failures", () => {
    const sources = ["a", "b"].flatMap((pod) =>
      ["json", "web"].map((name) => ({
        lane: pod,
        pod,
        container: name,
        info: container({ name }),
      }))
    );
    const lanes = readLanes(
      sources,
      [
        {
          pod: "b",
          container: "json",
          kind: "follow-stopped",
          message: "too many open files",
        },
      ],
      followed
    );
    expect(lanes.get("a")).toEqual({ reading: "streaming", note: null });
    expect(lanes.get("b")).toEqual({
      reading: "notFollowed",
      note: "too many open files",
    });
  });

  it("counts every reading, the ones nothing has is zero", () => {
    const counts = countReadings(["streaming", "streaming", "lost", undefined]);
    expect(counts.streaming).toBe(2);
    expect(counts.lost).toBe(1);
    expect(counts.restarting).toBe(0);
  });
});
