import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { LaneCoverage } from "./LaneCoverage";

const coverage = (
  overrides: Partial<Parameters<typeof LaneCoverage>[0]["coverage"]>
) => ({
  podsRead: true,
  total: 1,
  streaming: 1,
  refused: 0,
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
    draw(coverage({ podsRead: false }));
    expect(screen.getByText("pod list not read")).toHaveClass("text-warn");

    draw(coverage({}));
    expect(screen.getByText("1 of 1 pod streaming")).not.toHaveClass(
      "text-warn"
    );
  });

  /** Pods whose logs could not be read are the same gap, counted. */
  it("draws the pods it could not read from in the warning tone", () => {
    draw(coverage({ total: 2, refused: 1 }));
    expect(screen.getByText("1 pod could not be read")).toHaveClass(
      "text-warn"
    );
    expect(screen.getByTestId("log-lane-coverage").textContent).toContain(
      "1 of 2 pods streaming · 1 pod could not be read"
    );
  });
});
