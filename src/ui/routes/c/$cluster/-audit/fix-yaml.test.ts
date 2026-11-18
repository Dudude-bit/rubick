import { describe, expect, it } from "vite-plus/test";

import type { AuditFinding, RuleId } from "@/generated/types";
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
   * A container's own securityContext overrides the pod's, an autoscaler's
   * floor overrides the workload's replicas, and an ephemeral container
   * cannot be changed at all. Fails if a fix is put where the setting that
   * wins is left as it was.
   */
  it("puts each fix where the setting that wins is", () => {
    const root = (
      at: {
        list: "containers" | "ephemeralContainers";
        container: string;
      } | null
    ): AuditFinding => ({
      rule: "pss-run-as-user-root",
      severity: "medium",
      what: [
        { says: "set", at, field: "securityContext.runAsUser", value: "0" },
      ],
    });
    expect(
      fixYaml(
        "pss-run-as-user-root",
        "Pod",
        root({ list: "containers", container: "app" })
      )
    ).toBe(
      "spec:\n  containers:\n    - name: app\n      securityContext:\n        runAsUser: 10001\n        runAsGroup: 10001"
    );
    expect(fixYaml("pss-run-as-user-root", "Pod", root(null))).toBe(
      "spec:\n  securityContext:\n    runAsUser: 10001\n    runAsGroup: 10001"
    );
    expect(
      fixYaml("pss-seccomp-unconfined", "Deployment", {
        ...root({ list: "containers", container: "app" }),
        rule: "pss-seccomp-unconfined",
      })
    ).toMatch(
      /containers:\n {8}- name: app\n {10}securityContext:\n {12}seccompProfile:/
    );
    expect(
      fixYaml(
        "pss-run-as-user-root",
        "Pod",
        root({ list: "ephemeralContainers", container: "debugger" }),
        { kind: "Pod", namespace: "shop", name: "web-x" }
      )
    ).toBe("kubectl --context CONTEXT delete pod web-x --namespace shop");
    // Named after an ordinary container, as the backend names them: the
    // ephemeral one still cannot take a change, so the pod goes.
    const both = root({ list: "containers", container: "app" });
    both.what.push({
      says: "set",
      at: { list: "ephemeralContainers", container: "debugger" },
      field: "securityContext.runAsUser",
      value: "0",
    });
    expect(
      fixYaml("pss-run-as-user-root", "Pod", both, {
        kind: "Pod",
        namespace: "shop",
        name: "web-x",
      })
    ).toBe("kubectl --context CONTEXT delete pod web-x --namespace shop");
    const single = (
      autoscaler: string | null,
      ceiling: number | null = null
    ): AuditFinding => ({
      rule: "single-replica",
      severity: "medium",
      what: [{ says: "replicas", replicas: 1, autoscaler, ceiling }],
    });
    expect(fixYaml("single-replica", "Deployment", single("web", 6))).toBe(
      "apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: web\nspec:\n  minReplicas: 2"
    );
    // A ceiling of one is raised with the floor, or the pair is refused.
    expect(fixYaml("single-replica", "Deployment", single("web", 1))).toBe(
      "apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: web\nspec:\n  minReplicas: 2\n  maxReplicas: 2"
    );
    expect(fixYaml("single-replica", "Deployment", single(null))).toBe(
      "spec:\n  replicas: 2"
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
      "helm plugin install https://github.com/helm/helm-mapkubeapis\nhelm mapkubeapis web --namespace shop --kube-context CONTEXT\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress"
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

  /**
   * Objects that may still be stored at a deprecated version are rewritten
   * at the storage version and the old version taken out of the CRD's
   * status.storedVersions, the documented steps, named with the CRD; with
   * none stored there, manifests move to the version it serves undeprecated.
   * Fails if the migration were offered where nothing is stored, or named
   * no CRD.
   */
  it("migrates a CRD's stored objects only where they may be stored at the deprecated version", () => {
    const crd = {
      kind: "CustomResourceDefinition",
      namespace: null,
      name: "crontabs.example.com",
    };
    const storedAs = {
      says: "storedAs" as const,
      group: "example.com",
      kind: "CronTab",
      storage: "v1",
      stored: ["v1alpha1", "v1"],
      current: ["v1"],
    };
    const held: AuditFinding = {
      rule: "crd-version-deprecated",
      severity: "medium",
      what: [
        {
          says: "deprecated",
          version: "v1alpha1",
          warning: null,
          stored: true,
          storage: false,
        },
        storedAs,
      ],
    };
    expect(fixYaml(held.rule, crd.kind, held, crd)).toBe(
      "kubectl --context CONTEXT get crontabs.example.com --all-namespaces -o json | kubectl --context CONTEXT replace -f -\nkubectl --context CONTEXT patch customresourcedefinitions crontabs.example.com --subresource='status' --type='merge' -p '{\"status\":{\"storedVersions\":[\"v1\"]}}'"
    );
    const loose: AuditFinding = {
      ...held,
      severity: "low",
      what: [
        {
          says: "deprecated",
          version: "v1beta1",
          warning: null,
          stored: false,
          storage: false,
        },
        { ...storedAs, stored: ["v1"] },
      ],
    };
    expect(fixYaml(loose.rule, crd.kind, loose, crd)).toBe(
      "apiVersion: example.com/v1\nkind: CronTab"
    );
  });

  /** A client asking for a deprecated API moves to its replacement where the guide names one. */
  it("moves a client the server counted to the replacement, or shows what the group serves", () => {
    const asked: AuditFinding = {
      rule: "deprecated-api-requested",
      severity: "medium",
      what: [
        {
          says: "requested",
          kind: "Ingress",
          removed: "1.22",
          replacement: "networking.k8s.io/v1",
        },
      ],
    };
    expect(fixYaml(asked.rule, "DeprecatedAPI.k8s.io", asked)).toBe(
      "apiVersion: networking.k8s.io/v1\nkind: Ingress"
    );
    const unknown: AuditFinding = {
      ...asked,
      what: [
        { says: "requested", kind: null, removed: null, replacement: null },
      ],
    };
    expect(
      fixYaml(unknown.rule, "DeprecatedAPI.k8s.io", unknown, {
        kind: "DeprecatedAPI.k8s.io",
        namespace: null,
        name: "example.com/v1beta1 widgets/status",
      })
    ).toBe("kubectl --context CONTEXT api-resources --api-group=example.com");
  });

  /** Fails if a rule has no fix, or one with a word of prose in it. */
  /**
   * One finding about two containers is fixed in both: the backend folds
   * every container a rule found into one finding. Fails if the second
   * container keeps its setting, its literal or its floating image.
   */
  it("fixes every container a finding names, each with its own values", () => {
    const seat = (container: string) => ({
      list: "containers" as const,
      container,
    });
    const unconfined: AuditFinding = {
      rule: "pss-seccomp-unconfined",
      severity: "medium",
      what: [
        {
          says: "set",
          at: seat("app"),
          field: "securityContext.seccompProfile.type",
          value: "Unconfined",
        },
        {
          says: "set",
          at: seat("proxy"),
          field: "securityContext.seccompProfile.type",
          value: "Unconfined",
        },
      ],
    };
    const both = fixYaml("pss-seccomp-unconfined", "Pod", {
      ...unconfined,
      what: [
        {
          says: "set",
          at: null,
          field: "securityContext.seccompProfile.type",
          value: "Unconfined",
        },
        unconfined.what[0],
      ],
    });
    expect(both).toMatch(/^spec:\n {2}securityContext:\n {4}seccompProfile:/);
    expect(both).toContain("- name: app\n      securityContext:");
    const fix = fixYaml("pss-seccomp-unconfined", "Pod", unconfined);
    expect(fix).toContain(
      "- name: app\n      securityContext:\n        seccompProfile:"
    );
    expect(fix).toContain(
      "- name: proxy\n      securityContext:\n        seccompProfile:"
    );
    const images: AuditFinding = {
      rule: "image-tag-latest",
      severity: "low",
      what: [
        { says: "image", at: seat("app"), image: "web:latest" },
        { says: "image", at: seat("proxy"), image: "envoy" },
      ],
    };
    const pinned = fixYaml("image-tag-latest", "Pod", images);
    expect(pinned).toContain("- name: app\n      image: web:1.2.3");
    expect(pinned).toContain("- name: proxy\n      image: envoy:1.2.3");
    const literals: AuditFinding = {
      rule: "env-secret-literal",
      severity: "medium",
      what: [
        { says: "envLiteral", at: seat("app"), variable: "DB_PASSWORD" },
        { says: "envLiteral", at: seat("worker"), variable: "API_TOKEN" },
      ],
    };
    const env = fixYaml("env-secret-literal", "Pod", literals);
    expect(env).toMatch(/- name: app\n {6}env:\n {8}- name: DB_PASSWORD/);
    expect(env).toMatch(/- name: worker\n {6}env:\n {8}- name: API_TOKEN/);
  });

  /**
   * kubectl and helm act on their kubeconfig's current context unless told:
   * a pod deleted by name in the terminal's cluster may be another one's.
   * Fails if any command the fix offers leaves out the cluster on screen.
   */
  it("names the cluster on screen in every command it offers", () => {
    const ephemeral: AuditFinding = {
      rule: "pss-privileged",
      severity: "high",
      what: [
        {
          says: "set",
          at: { list: "ephemeralContainers", container: "debugger" },
          field: "securityContext.privileged",
          value: "true",
        },
      ],
    };
    const pod = { kind: "Pod", namespace: "shop", name: "web-x" };
    expect(fixYaml("pss-privileged", "Pod", ephemeral, pod, "kind-prod")).toBe(
      "kubectl --context kind-prod delete pod web-x --namespace shop"
    );
    expect(
      fixYaml("pss-privileged", "Pod", ephemeral, pod, "my cluster's prod")
    ).toBe(
      "kubectl --context 'my cluster'\\''s prod' delete pod web-x --namespace shop"
    );
    const commands = (RULE_IDS as readonly RuleId[])
      .map((rule) =>
        fixYaml(rule, "Deployment", undefined, undefined, "kind-prod")
      )
      .flatMap((text) => text.split("\n"))
      .filter(
        (line) =>
          /^(kubectl|helm) /.test(line) && !line.startsWith("helm plugin")
      );
    expect(commands.length).toBeGreaterThan(0);
    for (const line of commands)
      expect(line).toMatch(/--(kube-)?context kind-prod/);
  });

  it("offers a fix for every rule, written in the API's fields only", () => {
    for (const rule of RULE_IDS) {
      const yaml = fixYaml(rule, "Deployment");
      expect(yaml, rule).toBeTruthy();
      expect(yaml, rule).not.toMatch(/[<>]/);
    }
  });
});
