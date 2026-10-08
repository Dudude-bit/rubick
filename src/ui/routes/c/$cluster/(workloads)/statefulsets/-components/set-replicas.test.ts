import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { setReplicaSegments } from "./set-replicas";

const t: T = (section, key, values) => translate("en", section, key, values);

const shape = (segments: ReturnType<typeof setReplicaSegments>) =>
  segments.map(({ count, tone }) => [count, tone]);

describe("a StatefulSet's Replicas bar", () => {
  /**
   * Dana scaled orders-db to 2: for two seconds the bar said red "1 not
   * created" while kubectl had orders-db-1 Pending. Fails if a pod the page
   * read is still called not created, or the ordered queue is drawn red.
   */
  it("counts a pod the page has read as made before the controller counts it", () => {
    const counts = { desired: 2, current: 1, ready: 1 };
    const waiting = { state: "unobserved", available: 1, desired: 2 } as const;

    expect(shape(setReplicaSegments(counts, 2, waiting, t))).toEqual([
      [1, "ok"],
      [1, "warn"],
      [0, "neutral"],
    ]);
    expect(shape(setReplicaSegments(counts, 1, waiting, t))).toEqual([
      [1, "ok"],
      [0, "warn"],
      [1, "neutral"],
    ]);
  });

  /** A pod missing while the set is Unavailable is the fault, and stays red. */
  it("draws pods not made red only where the verdict is a fault", () => {
    const down = {
      state: "unavailable",
      reason: null,
      message: null,
      available: 0,
      desired: 2,
    } as const;
    expect(
      shape(
        setReplicaSegments({ desired: 2, current: 0, ready: 0 }, 0, down, t)
      )
    ).toEqual([
      [0, "ok"],
      [0, "warn"],
      [2, "err"],
    ]);
  });

  /** Scaling down, the pod still terminating is neither starting nor missing. */
  it("does not count a pod on its way out as starting", () => {
    expect(
      shape(
        setReplicaSegments(
          { desired: 1, current: 1, ready: 1 },
          2,
          { state: "ready" },
          t
        )
      )
    ).toEqual([
      [1, "ok"],
      [0, "warn"],
      [0, "neutral"],
    ]);
  });
});
