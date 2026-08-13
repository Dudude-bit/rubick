import { describe, it, expect } from "vitest";

import {
  attachAggregatedPodMetrics,
  matchDeploymentPods,
  matchStatefulSetPods,
  type PodWithMetrics,
} from "./metrics";

interface PodSpec {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  cpu?: number | null;
  memory?: number | null;
}

function pod({
  name,
  namespace = "default",
  labels = {},
  cpu = 10,
  memory = 100,
}: PodSpec): PodWithMetrics {
  return {
    name,
    namespace,
    labels,
    cpuMillicores: cpu,
    memoryBytes: memory,
  } as PodWithMetrics;
}

/** What the indexed version replaced: the pairwise scan, kept as the oracle. */
function byFilter<T extends { name: string; namespace: string }>(
  resources: T[],
  pods: PodWithMetrics[],
  matches: (resource: T, p: PodWithMetrics) => boolean
) {
  return resources.map((resource) => {
    const mine = pods.filter((p) => matches(resource, p));
    return {
      name: resource.name,
      cpuMillicores: mine.length
        ? mine.reduce((sum, p) => sum + (p.cpuMillicores ?? 0), 0)
        : null,
    };
  });
}

const usage = (rows: Array<{ name: string; cpuMillicores: number | null }>) =>
  rows.map((row) => [row.name, row.cpuMillicores] as const);

describe("attachAggregatedPodMetrics", () => {
  /**
   * The index has to answer exactly what the pairwise scan answered — it
   * is the same rule read from the other end, and a drift between them
   * is a workload row quietly reporting somebody else's usage.
   */
  it("matches the pairwise scan it replaced", () => {
    const deployments = [
      { name: "web", namespace: "default", labels: { app: "web" } },
      { name: "api", namespace: "default", labels: { app: "api" } },
      { name: "web", namespace: "other", labels: { app: "web" } },
    ];
    const pods = [
      pod({ name: "web-5d4c-x9", labels: { app: "web" } }),
      pod({ name: "web-5d4c-p2", labels: { app: "web" } }),
      pod({ name: "api-77b-aa", labels: { deployment: "api" } }),
      pod({ name: "loose-pod-1" }),
      pod({ name: "web-5d4c-zz", namespace: "other", labels: { app: "web" } }),
    ];

    expect(
      usage(attachAggregatedPodMetrics(deployments, pods, matchDeploymentPods))
    ).toEqual(usage(byFilter(deployments, pods, matchDeploymentPods)));
    expect(
      usage(attachAggregatedPodMetrics(deployments, pods, matchDeploymentPods))
    ).toEqual([
      ["web", 20],
      ["api", 10],
      ["web", 10],
    ]);
  });

  /**
   * A Deployment reaches the same pod by its `app` label and by the pod's
   * name at once. Counted once by the scan, so it has to be counted once
   * by the index — otherwise every properly labelled workload reports
   * double the CPU it is using.
   */
  it("counts a pod once even when it matches by several keys", () => {
    const deployments = [
      { name: "web", namespace: "default", labels: { app: "web" } },
    ];
    const pods = [pod({ name: "web-5d4c-x9", labels: { app: "web" } })];

    expect(
      usage(attachAggregatedPodMetrics(deployments, pods, matchDeploymentPods))
    ).toEqual([["web", 10]]);
  });

  /**
   * Two objects that are both unlabelled are not thereby the same app.
   * Comparing `labels.app` when neither side has one is `undefined ===
   * undefined`, which made every unlabelled Deployment in a namespace
   * report the sum of every unlabelled pod in it.
   */
  it("does not treat two unlabelled objects as the same app", () => {
    const deployments = [{ name: "web", namespace: "default" }];
    const pods = [pod({ name: "web-5d4c-x9" }), pod({ name: "unrelated-1" })];

    expect(
      usage(attachAggregatedPodMetrics(deployments, pods, matchDeploymentPods))
    ).toEqual([["web", 10]]);
  });

  /** A name is only unique inside its namespace. */
  it("never aggregates across namespaces", () => {
    const sets = [{ name: "db", namespace: "prod" }];
    const pods = [
      pod({ name: "db-0", namespace: "prod" }),
      pod({ name: "db-0", namespace: "staging" }),
    ];

    expect(
      usage(attachAggregatedPodMetrics(sets, pods, matchStatefulSetPods))
    ).toEqual([["db", 10]]);
  });

  /**
   * A pod name carries every workload name it could have come from:
   * `db-replica-0` is a pod of `db-replica`, and by the same rule also
   * looks like one of `db`. That ambiguity is the name-prefix rule's,
   * not the index's — pinned here so a change to the keys cannot quietly
   * answer differently from the scan they replaced.
   */
  it("reads a generated pod name the same way the scan did", () => {
    const sets = [
      { name: "db", namespace: "default" },
      { name: "db-replica", namespace: "default" },
    ];
    const pods = [pod({ name: "db-0" }), pod({ name: "db-replica-0" })];

    expect(
      usage(attachAggregatedPodMetrics(sets, pods, matchStatefulSetPods))
    ).toEqual(usage(byFilter(sets, pods, matchStatefulSetPods)));
    expect(
      usage(attachAggregatedPodMetrics(sets, pods, matchStatefulSetPods))
    ).toEqual([
      ["db", 20],
      ["db-replica", 10],
    ]);
  });

  /** A workload with no pods reports nothing, not zero. */
  it("reports unknown rather than zero for a workload with no pods", () => {
    const sets = [{ name: "db", namespace: "default" }];
    expect(attachAggregatedPodMetrics(sets, [], matchStatefulSetPods)).toEqual([
      {
        name: "db",
        namespace: "default",
        cpuMillicores: null,
        memoryBytes: null,
      },
    ]);
  });
});
