import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { describe, expect, it } from "vitest";

const t: T = (section, key, values) => translate("en", section, key, values);

import {
  applyWarnings,
  autoscalerFinding,
  autoscalerReplicas,
  autoscalers,
  budgetFinding,
  budgets,
  changesReplicaCount,
  drainBlockers,
  metricReadings,
  scaleWarnings,
} from "./governance";
import { connectionGroups } from "./connections";
import type { DeliveryIntercept } from "./delivery";
import type {
  ConditionInfo,
  ConnectionEdge,
  ObjectFacts,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";

const ref = (
  kind: string,
  name: string,
  facts: ObjectFacts | null
): ObjectRef => ({
  kind,
  name,
  namespace: "k8s-gui-test",
  existence: "present",
  facts,
});

const workload = ref("Deployment", "log-demo", {
  kind: "workload",
  replicas: 2,
  readyReplicas: 2,
  revision: null,
  current: null,
});

const condition = (
  type: string,
  status: string,
  reason: string,
  message: string
): ConditionInfo => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: null,
});

const hpa = (
  name: string,
  over: Partial<Extract<ObjectFacts, { kind: "autoscaler" }>> = {}
): ObjectRef =>
  ref("HorizontalPodAutoscaler", name, {
    kind: "autoscaler",
    minReplicas: 1,
    maxReplicas: 2,
    currentReplicas: 2,
    desiredReplicas: 2,
    metrics: [
      { name: "cpu", source: "resource", target: "50%", current: "210%" },
    ],
    conditions: [],
    lastScaleTime: null,
    ...over,
  });

const pdb = (
  name: string,
  over: Partial<Extract<ObjectFacts, { kind: "budget" }>> = {}
): ObjectRef =>
  ref("PodDisruptionBudget", name, {
    kind: "budget",
    minAvailable: "1",
    maxUnavailable: null,
    disruptionsAllowed: 1,
    currentHealthy: 2,
    desiredHealthy: 1,
    expectedPods: 2,
    conditions: [],
    ...over,
  });

const governs = (
  from: ObjectRef,
  to: ObjectRef = workload
): ConnectionEdge => ({
  from,
  to,
  relation: { verb: "governs", selector: null },
});

const conns = (
  edges: ConnectionEdge[],
  subject: ObjectRef = workload,
  notLookedAt: ResourceConnections["notLookedAt"] = []
): ResourceConnections => ({
  subject,
  edges,
  stops: [],
  published: [],
  notLookedAt,
});

describe("reading the two governing kinds", () => {
  it("pulls an autoscaler and a budget off the same edge list", () => {
    const answer = conns([governs(hpa("hpa-busy")), governs(pdb("pdb-log"))]);
    expect(autoscalers(answer).map((a) => a.object.name)).toEqual(["hpa-busy"]);
    expect(budgets(answer).map((b) => b.object.name)).toEqual(["pdb-log"]);
  });

  /**
   * The gap this feature closed, asserted from the reader's side. A page
   * that draws an autoscaler block and still carries a row saying the app
   * does not read autoscalers is worse than the honest gap it replaced.
   */
  it("does not carry a not-looked-at row for a kind it now reads", () => {
    const groups = connectionGroups(conns([governs(hpa("hpa-busy"))]), t);
    const unasked = groups.find((group) => group.key === "unasked");
    expect(unasked).toBeUndefined();

    const governed = groups.find((group) => group.key === "governs");
    expect(governed?.rows.map((row) => row.label)).toEqual(["Autoscaling"]);
  });

  it("still names a kind whose read the cluster refused", () => {
    const groups = connectionGroups(
      conns([], workload, [
        {
          kind: "HorizontalPodAutoscaler",
          why: { says: "unanswered", version: "autoscaling/v2", said: "404" },
        },
      ]),
      t
    );
    const unasked = groups.find((group) => group.key === "unasked");
    expect(unasked?.rows[0].label).toBe("Autoscaling");
  });
});

describe("what an autoscaler is worth saying", () => {
  it("says nothing about one that is simply working", () => {
    const auto = autoscalers(conns([governs(hpa("hpa-ok"))]))[0];
    expect(autoscalerFinding(auto, t)).toBeNull();
  });

  it("is loudest about one that cannot read its metrics", () => {
    const auto = autoscalers(
      conns([
        governs(
          hpa("hpa-blind", {
            conditions: [
              condition(
                "ScalingActive",
                "False",
                "FailedGetResourceMetric",
                "failed to get cpu utilization: missing request for cpu"
              ),
            ],
            metrics: [
              { name: "cpu", source: "resource", target: "80%", current: null },
            ],
          })
        ),
      ])
    )[0];
    const finding = autoscalerFinding(auto, t);
    expect(finding?.tone).toBe("err");
    expect(finding?.title).toContain("cannot read its metrics");
    expect(metricReadings(auto.facts)[0].current).toBeNull();
    // `desiredReplicas` stays at zero on an autoscaler that never computed,
    // and "0 wanted" beside two running pods reads as an imminent scale to
    // nothing rather than as an unset field.
    expect(autoscalerReplicas(auto.facts, t)).toContain("nothing computed");
  });

  it("calls a ceiling a ceiling and a floor a floor", () => {
    const ceiling = autoscalers(
      conns([
        governs(
          hpa("hpa-busy", {
            conditions: [
              condition(
                "ScalingLimited",
                "True",
                "TooManyReplicas",
                "the desired replica count is more than the maximum replica count"
              ),
            ],
          })
        ),
      ])
    )[0];
    expect(autoscalerFinding(ceiling, t)?.tone).toBe("warn");
    expect(autoscalerFinding(ceiling, t)?.title).toContain("ceiling");

    const floor = autoscalers(
      conns([
        governs(
          hpa("hpa-idle", {
            conditions: [
              condition(
                "ScalingLimited",
                "True",
                "TooFewReplicas",
                "below min"
              ),
            ],
          })
        ),
      ])
    )[0];
    // The same condition, the same status word, and a different finding —
    // which is why the reason is read rather than the status alone.
    expect(autoscalerFinding(floor, t)?.tone).toBe("neutral");
    expect(autoscalerFinding(floor, t)?.title).toContain("floor");
  });

  it("says nothing about a scale-down stabilisation window", () => {
    const auto = autoscalers(
      conns([
        governs(
          hpa("hpa-settling", {
            conditions: [
              condition(
                "ScalingLimited",
                "True",
                "ScaleDownStabilized",
                "recent recommendations were higher"
              ),
            ],
          })
        ),
      ])
    )[0];
    expect(autoscalerFinding(auto, t)).toBeNull();
  });
});

describe("the tone a disruption budget is allowed", () => {
  it("says nothing while there is room", () => {
    expect(
      budgetFinding(budgets(conns([governs(pdb("pdb-log"))]))[0], t)
    ).toBeNull();
  });

  /**
   * The case `condition-health.ts` already calls advisory. A one-replica
   * workload with `minAvailable: 1` reports `DisruptionAllowed=False` every
   * second of its healthy life, and colouring it claims a fault the cluster
   * never reported.
   */
  it("states a spent budget without spending a colour on it", () => {
    const budget = budgets(
      conns([
        governs(
          pdb("pdb-stateful", {
            disruptionsAllowed: 0,
            currentHealthy: 1,
            desiredHealthy: 1,
            expectedPods: 1,
          })
        ),
      ])
    )[0];
    const finding = budgetFinding(budget, t);
    expect(finding?.tone).toBe("neutral");
    expect(finding?.title).toContain("no disruption");
  });

  it("colours the budget that is below its own floor", () => {
    const budget = budgets(
      conns([
        governs(
          pdb("pdb-short", {
            disruptionsAllowed: 0,
            currentHealthy: 1,
            desiredHealthy: 2,
            expectedPods: 3,
          })
        ),
      ])
    )[0];
    expect(budgetFinding(budget, t)?.tone).toBe("warn");
  });
});

describe("what a drain is told", () => {
  it("names each blocking budget once, however many pods it covers", () => {
    const spent = pdb("pdb-stateful", {
      disruptionsAllowed: 0,
      currentHealthy: 1,
      desiredHealthy: 1,
      expectedPods: 1,
    });
    const podA = ref("Pod", "stateful-demo-0", null);
    const podB = ref("Pod", "stateful-demo-1", null);
    const blockers = drainBlockers(
      conns([
        governs(spent, podA),
        governs(spent, podB),
        governs(pdb("pdb-log")),
      ])
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0].pods).toBe(2);
  });
});

describe("what the Scale dialog reads", () => {
  const delivery: DeliveryIntercept = {
    title: "Scale — Argo CD will undo this",
    subject: "Argo CD",
    lead: "Argo CD will undo this.",
    description: "shop re-applies this object every three minutes.",
    confirmLabel: "Scale anyway",
    where: { path: "kustomize", revision: null, repoUrl: null, to: "/argo" },
  };

  /**
   * The regression this exists to catch. An autoscaler owns `spec.replicas`
   * and takes it back in about fifteen seconds; a Scale dialog that says
   * nothing about it is the same defect the delivery intercept was built for.
   */
  it("warns about an autoscaler", () => {
    const warnings = scaleWarnings(conns([governs(hpa("hpa-busy"))]), null, t);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].lead).toContain("hpa-busy");
    expect(warnings[0].description).toContain("1 and 2");
  });

  it("says the number stands while the autoscaler cannot act", () => {
    const warnings = scaleWarnings(
      conns([
        governs(
          hpa("hpa-blind", {
            conditions: [
              condition(
                "ScalingActive",
                "False",
                "FailedGetResourceMetric",
                "no metrics"
              ),
            ],
          })
        ),
      ]),
      null,
      t
    );
    expect(warnings[0].description).toContain("will stand");
    expect(warnings[0].description).toContain("FailedGetResourceMetric");
  });

  it("carries both reasons, soonest first, without repeating itself", () => {
    const warnings = scaleWarnings(
      conns([governs(hpa("hpa-busy"))]),
      delivery,
      t
    );
    expect(warnings.map((w) => w.subject)).toEqual([
      "The autoscaler hpa-busy",
      "Argo CD",
    ]);
    expect(warnings[0].description).not.toEqual(warnings[1].description);
  });

  it("refuses to state a range when two autoscalers claim one workload", () => {
    const warnings = scaleWarnings(
      conns([governs(hpa("hpa-a")), governs(hpa("hpa-b"))]),
      null,
      t
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].description).toContain("hpa-a, hpa-b");
    expect(warnings[0].description).toContain("undoes the other");
  });

  it("is silent on a workload nothing governs and nothing delivers", () => {
    expect(scaleWarnings(conns([]), null, t)).toEqual([]);
  });
});

describe("what the YAML editor's apply reads", () => {
  const delivery: DeliveryIntercept = {
    title: "Apply — Argo CD will undo this",
    subject: "Argo CD",
    lead: "Argo CD will undo this.",
    description: "shop re-applies this object every three minutes.",
    confirmLabel: "Apply anyway",
    where: { path: "kustomize", revision: null, repoUrl: null, to: "/argo" },
  };

  const doc = (replicas: number | null) =>
    [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "spec:",
      ...(replicas === null ? [] : [`  replicas: ${replicas}`]),
      "  template:",
      "    spec: {}",
      "",
    ].join("\n");

  /**
   * The judgement this whole gate exists for. An autoscaler owns
   * `spec.replicas` and nothing else, so naming it on a save that changed an
   * image tag would be a warning about something that will not happen — and a
   * dialog that is wrong on most saves is one people learn to dismiss unread.
   */
  it("stays quiet about the autoscaler when the save does not touch replicas", () => {
    const governed = conns([governs(hpa("hpa-busy"))]);
    const before = doc(3);
    // A real edit somewhere else in the document. Replacing a string with
    // itself would leave `after === before`, and this test would pass even
    // if the gate named the autoscaler on every save — which is the failure
    // it exists to catch.
    const after = before.replace("    spec: {}", "    spec: { nodeName: n1 }");
    expect(after).not.toBe(before);
    expect(
      applyWarnings(governed, null, changesReplicaCount(before, after), t)
    ).toEqual([]);
    expect(changesReplicaCount(doc(3), doc(3) + "# a comment\n")).toBe(false);
  });

  it("names the autoscaler when the replica count is what moved", () => {
    const warnings = applyWarnings(
      conns([governs(hpa("hpa-busy"))]),
      null,
      changesReplicaCount(doc(3), doc(5)),
      t
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].lead).toContain("hpa-busy");
  });

  /**
   * A delivery controller re-applies the whole object, so it is true whatever
   * was edited — the gate above must never be allowed to swallow it.
   */
  it("warns about delivery on any save, replicas or not", () => {
    const warnings = applyWarnings(conns([]), delivery, false, t);
    expect(warnings.map((w) => w.subject)).toEqual(["Argo CD"]);
  });

  it("stacks the two, soonest first, when the save moves replicas too", () => {
    const warnings = applyWarnings(
      conns([governs(hpa("hpa-busy"))]),
      delivery,
      true,
      t
    );
    expect(warnings.map((w) => w.subject)).toEqual([
      "The autoscaler hpa-busy",
      "Argo CD",
    ]);
  });

  it("reads a replica count out of either document, or neither", () => {
    expect(changesReplicaCount(doc(3), doc(null))).toBe(true);
    expect(changesReplicaCount(doc(null), doc(null))).toBe(false);
    // A document that will not parse is about to fail on the API server, and
    // its message is better than anything guessed here.
    expect(changesReplicaCount(doc(3), "spec: [broken\n")).toBe(false);
  });
});
