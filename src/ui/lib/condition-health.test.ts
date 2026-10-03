import { describe, expect, it } from "vitest";

import {
  cautioningCondition,
  conditionRole,
  failingCondition,
} from "./condition-health";
import type { ConditionInfo } from "@/generated/types";

function condition(
  type: string,
  status: string,
  extra: Partial<ConditionInfo> = {}
): ConditionInfo {
  return {
    type,
    status,
    reason: null,
    message: null,
    lastTransitionTime: null,
    ...extra,
  };
}

describe("conditionRole", () => {
  it("reads a satisfied condition as ok, whichever value satisfies it", () => {
    expect(conditionRole(condition("Ready", "True"))).toBe("ok");
    // A node reports pressure by setting the condition, so False is health.
    expect(conditionRole(condition("MemoryPressure", "False"))).toBe("ok");
    expect(conditionRole(condition("PodReadyToStartContainers", "True"))).toBe(
      "ok"
    );
  });

  it("reads a genuine failure as an error", () => {
    expect(conditionRole(condition("Ready", "False"))).toBe("err");
    expect(conditionRole(condition("PodScheduled", "False"))).toBe("err");
    expect(conditionRole(condition("DiskPressure", "True"))).toBe("err");
  });

  it("does not call a spent disruption budget a failure", () => {
    // The case the true/false model got wrong: a PDB that is currently
    // holding says False, and that is the budget working.
    expect(conditionRole(condition("DisruptionAllowed", "False"))).toBe(
      "neutral"
    );
    expect(conditionRole(condition("Suspended", "True"))).toBe("neutral");
  });

  it("reads a lifecycle step that has not happened yet as pending", () => {
    expect(conditionRole(condition("Initialized", "False"))).toBe("pending");
    expect(conditionRole(condition("PodReadyToStartContainers", "False"))).toBe(
      "pending"
    );
  });

  it("reads an unreported condition as a warning, not a failure", () => {
    expect(conditionRole(condition("Ready", "Unknown"))).toBe("warn");
  });

  it("ignores the spelling of the type", () => {
    expect(conditionRole(condition("memory-pressure", "False"))).toBe("ok");
  });
});

describe("failingCondition", () => {
  it("returns the first condition that is actually wrong", () => {
    const conditions = [
      condition("Initialized", "False"),
      condition("DisruptionAllowed", "False"),
      condition("PodScheduled", "False", { reason: "Unschedulable" }),
    ];
    expect(failingCondition(conditions)?.type).toBe("PodScheduled");
  });

  it("skips the types the caller says it can describe better", () => {
    const conditions = [condition("Ready", "False"), condition("Foo", "False")];
    expect(failingCondition(conditions, ["Ready"])?.type).toBe("Foo");
  });

  it("returns nothing when everything is satisfied", () => {
    expect(failingCondition([condition("Ready", "True")])).toBeNull();
  });
});

describe("a Gateway listener's overlapping TLS config", () => {
  /**
   * `*.example.com` beside `foo.example.com` sets `OverlappingTLSConfig=True`
   * on both listeners, and both serve; it read as a failure and painted two
   * working listeners red. Fails if the caution is read as a fault again, or
   * is dropped rather than said.
   */
  it("reads a reported overlap as a caution, not a failure", () => {
    const overlap = condition("OverlappingTLSConfig", "True", {
      reason: "OverlappingHostnames",
    });
    const conditions = [condition("Accepted", "True"), overlap];

    expect(conditionRole(overlap)).toBe("warn");
    expect(failingCondition(conditions)).toBeNull();
    expect(cautioningCondition(conditions)).toBe(overlap);
    expect(conditionRole(condition("OverlappingTLSConfig", "False"))).toBe(
      "ok"
    );
  });
});
