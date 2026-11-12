import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { LaneCoverage } from "./LaneCoverage";
import { countReadings, type StreamReading } from "./readings";

const coverage = (
  readings: StreamReading[],
  overrides: Partial<Parameters<typeof LaneCoverage>[0]["coverage"]> = {}
) => ({
  podsRead: true,
  total: readings.length,
  counts: countReadings(readings),
  gone: 0,
  ...overrides,
});

const draw = (c: ReturnType<typeof coverage>) =>
  render(
    <LaneCoverage
      coverage={c}
      paused={false}
      rule="pod"
      mode="colour"
      onModeChange={() => {}}
    />
  );

describe("the lane coverage line", () => {
  /**
   * "pod list not read" was drawn in the same faint grey as "1 of 1 pod
   * streaming": the words changed and the tone still said nothing was wrong.
   */
  it("draws a pod list it could not read in the warning tone, and a counted one without it", () => {
    draw(coverage(["streaming"], { podsRead: false }));
    expect(screen.getByText("pod list not read")).toHaveClass("text-warn");

    draw(coverage(["streaming"]));
    expect(screen.getByText("1 of 1 pod streaming")).not.toHaveClass(
      "text-warn"
    );
  });

  /** Pods whose logs could not be read are the same gap, counted. */
  it("draws the pods it could not read from in the warning tone", () => {
    draw(coverage(["streaming", "lost"]));
    expect(screen.getByText("1 pod could not be read")).toHaveClass(
      "text-warn"
    );
    expect(screen.getByTestId("log-lane-coverage").textContent).toContain(
      "1 of 2 pods streaming · 1 pod could not be read"
    );
  });

  /**
   * A pod whose log the node dropped is as unread as one whose stream broke,
   * and a pod is counted once: the clauses add up to the total.
   */
  it("adds the clauses up to the pods, one clause per pod", () => {
    draw(
      coverage([
        "streaming",
        "ended",
        "read",
        "restarting",
        "notFollowed",
        "notStarted",
        "lost",
        "notKept",
        "absent",
      ])
    );
    expect(screen.getByTestId("log-lane-coverage").textContent).toContain(
      "1 of 9 pods streaming · 2 finished, read to the end · 1 restarting, new run not followed · 1 not followed · 1 not started · 2 pods could not be read · 1 with no earlier run"
    );
  });

  /** Each of these is a pod the pane is not following, and the tone says so. */
  it("draws a pod it is not following in the warning tone, and one it read to the end without", () => {
    draw(coverage(["restarting", "notFollowed", "notStarted", "ended"]));
    expect(screen.getByText("1 restarting, new run not followed")).toHaveClass(
      "text-warn"
    );
    expect(screen.getByText("1 not followed")).toHaveClass("text-warn");
    expect(screen.getByText("1 not started")).toHaveClass("text-warn");
    expect(screen.getByText("1 finished, read to the end")).not.toHaveClass(
      "text-warn"
    );
  });
});
