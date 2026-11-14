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

  /**
   * A release whose stored manifest names a version this cluster no longer
   * serves is mapped in place by the Helm plugin, named with the release, and
   * its chart moves each kind to its replacement; a version still served
   * needs the chart alone, and PodSecurityPolicy, with no replacement, needs
   * Pod Security Admission. Fails if the plugin were offered for a version
   * it would not map yet, or the fix named no release.
   */
  it("maps a release's stored manifest only where a version is already gone", () => {
    const release = {
      kind: "HelmRelease.helm.sh",
      namespace: "shop",
      name: "web",
    };
    const stored = (served: boolean, api: string, kind: string) => ({
      says: "stored" as const,
      kind,
      name: "web",
      api,
      served,
      removal: {
        removed: "1.22",
        replacement:
          kind === "PodSecurityPolicy" ? null : "networking.k8s.io/v1",
        since: null,
      },
    });
    const gone: AuditFinding = {
      rule: "removed-api-in-helm-release",
      severity: "high",
      what: [
        { says: "revision", revision: 2, status: "deployed" },
        stored(false, "extensions/v1beta1", "Ingress"),
        stored(false, "networking.k8s.io/v1beta1", "Ingress"),
      ],
    };
    expect(fixYaml(gone.rule, release.kind, gone, release)).toBe(
      "helm plugin install https://github.com/helm/helm-mapkubeapis\nhelm mapkubeapis web --namespace shop\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress"
    );
    const due: AuditFinding = {
      ...gone,
      severity: "medium",
      what: [stored(true, "policy/v1beta1", "PodSecurityPolicy")],
    };
    const fix = fixYaml(due.rule, release.kind, due, release);
    expect(fix).not.toMatch(/mapkubeapis/);
    expect(fix).toMatch(/pod-security\.kubernetes\.io\/enforce: baseline/);
  });

  /** A writer's fix is its object's kind at the version replacing the one it wrote through. */
  it("moves a writer to the version that replaces the one it wrote through", () => {
    const written: AuditFinding = {
      rule: "deprecated-api-writer",
      severity: "medium",
      what: [
        {
          says: "written",
          manager: "ci",
          operation: "Update",
          time: null,
          api: "batch/v1beta1",
          removal: { removed: "1.25", replacement: "batch/v1", since: "1.21" },
        },
      ],
    };
    expect(fixYaml(written.rule, "CronJob", written)).toBe(
      "apiVersion: batch/v1\nkind: CronJob"
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
