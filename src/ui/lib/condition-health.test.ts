import { describe, expect, it } from "vite-plus/test";

import {
  cautioningCondition,
  conditionRole as roleAmong,
  failingCondition,
} from "./condition-health";
import { autoscalerVerdict, type AutoscalerFacts } from "./governance";
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

const conditionRole = (one: ConditionInfo) => roleAmong(one, [one]);

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

describe("a condition its reason settles", () => {
  const said = (type: string, status: string, reason: string | null = null) =>
    conditionRole(condition(type, status, { reason }));

  /**
   * cert-manager writes Issuing=False with `Issued` on a healthy certificate
   * under its ServerSideApply gate, and True for the whole of a renewal: the
   * conditions block painted the first red and the second green. Fails if
   * Issuing is read by its status word alone again.
   */
  it("reads cert-manager's Issuing as under way, issued or failed", () => {
    expect(said("Issuing", "True", "Renewing")).toBe("pending");
    expect(said("Issuing", "True")).toBe("pending");
    expect(said("Issuing", "False", "Issued")).toBe("ok");
    expect(said("Issuing", "False", "Failed")).toBe("err");
    expect(said("Issuing", "False")).toBe("err");
    const issued = condition("Issuing", "False", { reason: "Issued" });
    expect(failingCondition([condition("Ready", "True"), issued])).toBeNull();
  });

  /**
   * A Job's finished pod says Ready=False and ContainersReady=False with the
   * reason `PodCompleted`: two red rows and a warning on the Conditions tab
   * of a pod that did what it was for. Fails if either reads as a failure,
   * or if a pod not ready for any other reason stops reading as one.
   */
  it("does not call a pod that ran to completion a failure", () => {
    expect(said("Ready", "False", "PodCompleted")).toBe("neutral");
    expect(said("ContainersReady", "False", "PodCompleted")).toBe("neutral");
    expect(said("Ready", "False", "PodFailed")).toBe("err");
    expect(said("Ready", "False", "ContainersNotReady")).toBe("err");
    expect(
      failingCondition([
        condition("Initialized", "True", { reason: "PodCompleted" }),
        condition("Ready", "False", { reason: "PodCompleted" }),
        condition("ContainersReady", "False", { reason: "PodCompleted" }),
        condition("PodScheduled", "True"),
      ])
    ).toBeNull();
  });

  /**
   * The Conditions tab of a completed Job's pod drew a blue clock on
   * PodReadyToStartContainers=False: the kubelet gives that row no reason,
   * and only the rows beside it say the pod ended. Fails if a step of a pod
   * that completed or failed reads as on its way, or if one of a pod still
   * starting stops reading so.
   */
  it("does not call a step of a pod that has ended on its way", () => {
    const sandbox = condition("PodReadyToStartContainers", "False");
    const waiting = condition("Initialized", "False", {
      reason: "ContainersNotInitialized",
    });
    const ended = (reason: string) => [
      sandbox,
      waiting,
      condition("Ready", "False", { reason }),
    ];
    expect(roleAmong(sandbox, ended("PodCompleted"))).toBe("neutral");
    expect(roleAmong(sandbox, ended("PodFailed"))).toBe("neutral");
    expect(roleAmong(waiting, ended("PodFailed"))).toBe("neutral");
    expect(roleAmong(sandbox, ended("ContainersNotReady"))).toBe("pending");
    expect(roleAmong(waiting, ended("ContainersNotReady"))).toBe("pending");
  });

  /**
   * Flux's Stalled=True and Reconciling=True, a CRD's NonStructuralSchema=True
   * and an evicted pod's DisruptionTarget=True drew a green tick, and so did
   * what a stuck namespace's deletion failed at. Fails if a condition that
   * names trouble reads as satisfied when True, or as trouble when False.
   */
  it("reads a condition that names trouble as healthy when False", () => {
    expect(said("Stalled", "True", "DependencyNotReady")).toBe("err");
    expect(said("Stalled", "False")).toBe("ok");
    expect(said("Reconciling", "True", "ProgressingWithRetry")).toBe("pending");
    expect(said("Reconciling", "False")).toBe("ok");
    expect(said("NonStructuralSchema", "True", "Violations")).toBe("warn");
    expect(said("NonStructuralSchema", "False")).toBe("ok");
    expect(said("DisruptionTarget", "True", "PreemptionByScheduler")).toBe(
      "warn"
    );
    expect(said("NamespaceDeletionContentFailure", "True")).toBe("err");
    expect(said("NamespaceDeletionDiscoveryFailure", "True")).toBe("err");
    expect(said("NamespaceDeletionGroupVersionParsingFailure", "True")).toBe(
      "err"
    );
    expect(said("NamespaceFinalizersRemaining", "True")).toBe("pending");
    expect(said("NamespaceContentRemaining", "True")).toBe("pending");
    expect(said("NamespaceContentRemaining", "False", "ContentRemoved")).toBe(
      "ok"
    );
  });

  /**
   * An autoscaler inside its range says ScalingLimited=False, which read as
   * a failure on every healthy one, and at its ceiling True, which read as
   * satisfied. Fails if a condition's row and the workload page's finding
   * about the same condition differ in tone.
   */
  it("gives an autoscaler's condition the tone its workload's page gives it", () => {
    const cases: Array<[string, string, string]> = [
      ["AbleToScale", "True", "ReadyForNewScale"],
      ["AbleToScale", "False", "FailedGetScale"],
      ["ScalingActive", "True", "ValidMetricFound"],
      ["ScalingActive", "False", "ScalingDisabled"],
      ["ScalingActive", "False", "FailedGetResourceMetric"],
      ["ScalingLimited", "False", "DesiredWithinRange"],
      ["ScalingLimited", "True", "TooFewReplicas"],
      ["ScalingLimited", "True", "TooManyReplicas"],
    ];
    const tones = cases.map(([type, status, reason]) => {
      const one = condition(type, status, { reason });
      const facts = { conditions: [one] } as unknown as AutoscalerFacts;
      expect(conditionRole(one), `${type}=${status}/${reason}`).toBe(
        autoscalerVerdict(facts)?.tone ?? "ok"
      );
      return conditionRole(one);
    });
    expect(tones).toEqual([
      "ok",
      "err",
      "ok",
      "neutral",
      "warn",
      "ok",
      "neutral",
      "warn",
    ]);
  });

  /**
   * `SyncFailed` is the disruption controller failing to work a budget out,
   * with no disruption allowed until it can; it read as a budget merely
   * spent. Fails if it is not an error, or if a spent budget becomes one.
   */
  it("calls a budget its controller could not compute a failure", () => {
    expect(said("DisruptionAllowed", "False", "SyncFailed")).toBe("err");
    expect(said("DisruptionAllowed", "False", "InsufficientPods")).toBe(
      "neutral"
    );
  });

  /**
   * A paused Deployment says Progressing=Unknown, which read as a controller
   * that stopped reporting. Fails if a pause somebody asked for warns, or if
   * any other Unknown stops warning.
   */
  it("does not warn about a rollout somebody paused", () => {
    expect(said("Progressing", "Unknown", "DeploymentPaused")).toBe("neutral");
    expect(said("Progressing", "Unknown")).toBe("warn");
    expect(said("Progressing", "False", "ProgressDeadlineExceeded")).toBe(
      "err"
    );
  });
});
