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
    expect(workloadStatus({ ready: 0, desired: 0 })).toBe("Idle");
    // And the colour follows the word, so this has to be neutral: a
    // deliberate scale-down is neither a fault nor a state to celebrate.
    expect(statusRole("Idle")).toBe("neutral");
  });

  it("is ready only when every replica asked for has arrived", () => {
    expect(workloadStatus({ ready: 3, desired: 3 })).toBe("Ready");
    expect(workloadStatus({ ready: 4, desired: 3 })).toBe("Ready");
    expect(workloadStatus({ ready: 2, desired: 3 })).toBe("Progressing");
    expect(workloadStatus({ ready: 0, desired: 3 })).toBe("Progressing");
  });

  /**
   * `ready` and `available` are different numbers, and `minReadySeconds`
   * is the gap: a pod counts as ready before the Deployment controller will
   * count it as available. The callers used to choose — the list passed
   * `available`, the peek passed `ready` — so one Deployment mid-rollout read
   * Progressing in the list and Ready in the panel opened from it. The choice
   * belongs here, and it is the stricter number.
   */
  it("believes availability over readiness where a workload reports both", () => {
    expect(workloadStatus({ ready: 3, desired: 3, available: 1 })).toBe(
      "Progressing"
    );
    // And a workload that reports no availability at all is judged on what it
    // does report, rather than on a zero it never claimed.
    expect(workloadStatus({ ready: 3, desired: 3 })).toBe("Ready");
  });

  /** Every word it can produce has to be one the colour table knows. */
  it("only ever says something statusRole can colour", () => {
    expect(statusRole(workloadStatus({ ready: 3, desired: 3 }))).toBe("ok");
    expect(statusRole(workloadStatus({ ready: 1, desired: 3 }))).toBe(
      "pending"
    );
    expect(statusRole(workloadStatus({ ready: 0, desired: 0 }))).toBe(
      "neutral"
    );
  });
});
