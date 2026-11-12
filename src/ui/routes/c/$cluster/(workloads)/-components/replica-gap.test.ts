import { describe, expect, it } from "vite-plus/test";

import type { PodStart } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { replicaSplit } from "./replica-gap";

const t: T = (section, key, values) => translate("en", section, key, values);

const NOW = Date.parse("2026-10-09T07:09:04Z");
const pod = (
  start: PodStart,
  status: { display: string; ready: boolean; loopingUntil?: string } = {
    display: "Pending",
    ready: false,
  }
) => ({ start, status: { exitUnreported: false, ...status } });
const starting = (secondsLeft: number) =>
  pod({
    state: "starting",
    until: new Date(NOW + secondsLeft * 1000).toISOString(),
  });
const failing = pod({ state: "failing" }, { display: "Error", ready: false });
const ready = pod({ state: "settled" }, { display: "Running", ready: true });
const upBetweenCrashes = pod(
  { state: "settled" },
  {
    display: "Running",
    ready: true,
    loopingUntil: new Date(NOW + 60_000).toISOString(),
  }
);

const drawn = ({ ready, gap }: ReturnType<typeof replicaSplit>) => [
  ...(ready > 0 ? [[ready, "ready", "ok"]] : []),
  ...gap
    .filter((segment) => segment.count > 0)
    .map(({ label, count, tone }) => [count, label, tone]),
];

describe("a Replicas bar", () => {
  /**
   * Sam's checkout ReplicaSet said amber "2 starting" while both its pods
   * had crash-looped fourteen times. Fails if a failing pod is counted as
   * starting, or drawn in anything but red.
   */
  it("draws pods that keep failing as failing, not starting", () => {
    expect(drawn(replicaSplit(2, 0, [failing, failing], NOW, t))).toEqual([
      [2, "failing", "err"],
    ]);
  });

  /**
   * In each four seconds a crash-looping pod was up, the bar read red "1
   * failing" and amber "1 not ready" while its row was red Running, 1/1
   * ready, and the controller had not yet counted it. Fails if a pod up
   * between crashes leaves the failing part, or the split takes the
   * controller's lagging count over the pods the rows show.
   */
  it("keeps a pod up between crashes failing, and splits by the pods rather than the controller's count", () => {
    expect(
      drawn(replicaSplit(2, 0, [upBetweenCrashes, failing], NOW, t))
    ).toEqual([[2, "failing", "err"]]);
    expect(drawn(replicaSplit(2, 0, [ready, failing], NOW, t))).toEqual([
      [1, "ready", "ok"],
      [1, "failing", "err"],
    ]);
    expect(drawn(replicaSplit(2, 2, [ready, failing], NOW, t))).toEqual([
      [1, "ready", "ok"],
      [1, "failing", "err"],
    ]);
    const over = new Date(NOW - 1_000).toISOString();
    expect(
      drawn(
        replicaSplit(
          1,
          0,
          [pod(ready.start, { ...ready.status, loopingUntil: over })],
          NOW,
          t
        )
      )
    ).toEqual([[1, "ready", "ok"]]);
  });

  /**
   * big-pull's bar read amber "1 not ready" under a blue "coming up"
   * header while its pod pulled an image. Fails if a pod inside its wait is
   * a warning on the bar, or one past it is let off as starting.
   */
  it("draws a pod inside its wait as starting in blue, and one past it as not ready", () => {
    expect(drawn(replicaSplit(1, 0, [starting(30)], NOW, t))).toEqual([
      [1, "starting", "pending"],
    ]);
    expect(drawn(replicaSplit(1, 0, [starting(-1)], NOW, t))).toEqual([
      [1, "not ready", "warn"],
    ]);
  });

  /** Fails if pods nobody read are guessed at, or more pods than were made are drawn. */
  it("leaves the split to the controller's count where the pods were not read", () => {
    expect(drawn(replicaSplit(2, 0, null, NOW, t))).toEqual([
      [2, "not ready", "warn"],
    ]);
    expect(drawn(replicaSplit(3, 1, null, NOW, t))).toEqual([
      [1, "ready", "ok"],
      [2, "not ready", "warn"],
    ]);
    expect(
      drawn(replicaSplit(1, 0, [failing, starting(30), starting(30)], NOW, t))
    ).toEqual([[1, "failing", "err"]]);
  });

  /**
   * Sam's big-pull page said blue "Pods coming up" in its header over an
   * amber "1 not ready" bar, its pods not read or not made yet. Fails if a
   * replica no pod read accounts for is amber while the header waits on it,
   * amber turns blue when it does not, or a pod read past its wait is let
   * off as starting.
   */
  it("draws a replica no pod read accounts for as starting while the header waits on its pods", () => {
    expect(drawn(replicaSplit(1, 0, null, NOW, t, true))).toEqual([
      [1, "starting", "pending"],
    ]);
    expect(drawn(replicaSplit(2, 0, [], NOW, t, true))).toEqual([
      [2, "starting", "pending"],
    ]);
    expect(drawn(replicaSplit(2, 0, [starting(-1)], NOW, t, true))).toEqual([
      [1, "starting", "pending"],
      [1, "not ready", "warn"],
    ]);
    expect(drawn(replicaSplit(1, 0, null, NOW, t, false))).toEqual([
      [1, "not ready", "warn"],
    ]);
  });

  /**
   * The legend prints the count before the label, and Lena's read "1
   * запускаются" and "1 сбоят". Fails if a segment's words stop agreeing
   * with its own count, or a DaemonSet's node takes a replica's gender.
   */
  it("words each segment in Russian by its own count", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    const said = (split: ReturnType<typeof replicaSplit>) =>
      split.gap
        .filter((segment) => segment.count > 0)
        .map(({ count, label }) => `${count} ${label}`);

    expect(said(replicaSplit(2, 0, [starting(30), failing], NOW, ru))).toEqual([
      "1 запускается",
      "1 сбоит",
    ]);
    expect(
      said(replicaSplit(5, 0, [failing, failing, starting(30)], NOW, ru))
    ).toEqual(["1 запускается", "2 сбоят", "2 не готовы"]);
    expect(said(replicaSplit(1, 0, null, NOW, ru))).toEqual(["1 не готова"]);
    expect(said(replicaSplit(1, 0, null, NOW, ru, false, "node"))).toEqual([
      "1 не готов",
    ]);
  });
});
