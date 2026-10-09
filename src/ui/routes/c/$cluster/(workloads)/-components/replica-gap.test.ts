import { describe, expect, it } from "vite-plus/test";

import type { PodStart } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { replicaGap } from "./replica-gap";

const t: T = (section, key, values) => translate("en", section, key, values);

const NOW = Date.parse("2026-10-09T07:09:04Z");
const starting = (secondsLeft: number): { start: PodStart } => ({
  start: {
    state: "starting",
    until: new Date(NOW + secondsLeft * 1000).toISOString(),
  },
});
const failing: { start: PodStart } = { start: { state: "failing" } };

const drawn = (segments: ReturnType<typeof replicaGap>) =>
  segments
    .filter((segment) => segment.count > 0)
    .map(({ label, count, tone }) => [count, label, tone]);

describe("the not-ready part of a Replicas bar", () => {
  /**
   * Sam's checkout ReplicaSet said amber "2 starting" while both its pods
   * had crash-looped fourteen times. Fails if a failing pod is counted as
   * starting, or drawn in anything but red.
   */
  it("draws pods that keep failing as failing, not starting", () => {
    expect(drawn(replicaGap(2, [failing, failing], NOW, t))).toEqual([
      [2, "failing", "err"],
    ]);
  });

  /**
   * big-pull's bar read amber "1 not ready" under a blue "coming up"
   * header while its pod pulled an image. Fails if a pod inside its wait is
   * a warning on the bar, or one past it is let off as starting.
   */
  it("draws a pod inside its wait as starting in blue, and one past it as not ready", () => {
    expect(drawn(replicaGap(1, [starting(30)], NOW, t))).toEqual([
      [1, "starting", "pending"],
    ]);
    expect(drawn(replicaGap(1, [starting(-1)], NOW, t))).toEqual([
      [1, "not ready", "warn"],
    ]);
  });

  /** Fails if pods nobody read are guessed at, or more pods than the gap are drawn. */
  it("leaves the gap to the controller's count where the pods were not read", () => {
    expect(drawn(replicaGap(2, null, NOW, t))).toEqual([
      [2, "not ready", "warn"],
    ]);
    expect(
      drawn(replicaGap(1, [failing, starting(30), starting(30)], NOW, t))
    ).toEqual([[1, "failing", "err"]]);
  });
});
