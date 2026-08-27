import { describe, expect, it } from "vitest";

import { statusRole } from "./status-role";
import { workloadStatus } from "./workload-status";

/**
 * This existed twice and the copies disagreed. The list read
 * `available === desired`, which calls a Deployment scaled to zero
 * **Available**; the peek read `desired > 0 && ready >= desired`, which calls
 * the same object **Progressing**. Green tick and blue clock, one object, one
 * second apart.
 */
describe("the word a workload's counts add up to", () => {
  it("calls a scale-down what it is, rather than health or motion", () => {
    expect(workloadStatus(0, 0)).toBe("Idle");
    // And the colour follows the word, so this has to be neutral: a
    // deliberate scale-down is neither a fault nor a state to celebrate.
    expect(statusRole("Idle")).toBe("neutral");
  });

  it("is ready only when every replica asked for has arrived", () => {
    expect(workloadStatus(3, 3)).toBe("Ready");
    expect(workloadStatus(4, 3)).toBe("Ready");
    expect(workloadStatus(2, 3)).toBe("Progressing");
    expect(workloadStatus(0, 3)).toBe("Progressing");
  });

  /** Every word it can produce has to be one the colour table knows. */
  it("only ever says something statusRole can colour", () => {
    for (const [ready, desired] of [
      [0, 0],
      [3, 3],
      [1, 3],
    ]) {
      expect(statusRole(workloadStatus(ready, desired))).not.toBe(
        "neutral-unknown"
      );
    }
    expect(statusRole(workloadStatus(3, 3))).toBe("ok");
    expect(statusRole(workloadStatus(1, 3))).toBe("pending");
  });
});
