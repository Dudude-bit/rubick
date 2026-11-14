import { describe, expect, it } from "vite-plus/test";

import type { AuditFinding } from "@/generated/types";
import { fixYaml } from "./fix-yaml";
import { RULE_IDS } from "./rules";

const privileged: AuditFinding = {
  rule: "pss-privileged",
  severity: "high",
  what: [
    {
      says: "set",
      at: { list: "initContainers", container: "setup" },
      field: "securityContext.privileged",
      value: "true",
    },
  ],
};

describe("the fix Audit offers to copy", () => {
  /**
   * A CronJob keeps its pod spec two levels deeper than a Deployment and a
   * Pod one level shallower. Fails if a fix is laid out at the wrong path,
   * where merging it changes nothing.
   */
  it("lays the fix out where the object's kind keeps its pod spec", () => {
    expect(fixYaml("pss-privileged", "CronJob", privileged)).toMatch(
      /^spec:\n {2}jobTemplate:\n {4}spec:\n {6}template:\n {8}spec:\n {10}initContainers:\n {12}- name: setup\n/
    );
    expect(fixYaml("pss-privileged", "Pod", privileged)).toMatch(
      /^spec:\n {2}initContainers:\n {4}- name: setup\n {6}securityContext:\n {8}privileged: false$/
    );
  });

  /** Fails if a rule has no fix, or one with a word of prose in it. */
  it("offers a fix for every rule, written in the API's fields only", () => {
    for (const rule of RULE_IDS) {
      const yaml = fixYaml(rule, "Deployment");
      expect(yaml, rule).toBeTruthy();
      expect(yaml, rule).not.toMatch(/[<>]/);
    }
  });
});
