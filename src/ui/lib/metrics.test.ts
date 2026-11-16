import { describe, it, expect } from "vite-plus/test";
import type { PodMetrics } from "@/generated/types";

import {
  attachAggregatedPodMetrics,
  matchCronJobPods,
  matchDeploymentPods,
  matchStatefulSetPods,
  mergePodsWithMetrics,
  type PodWithMetrics,
} from "./metrics";

interface PodSpec {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  /** `Kind/name` of the workload its controller reference names. */
  of?: string;
  cpu?: number | null;
  memory?: number | null;
  phase?: string;
  state?: "running" | "waiting";
}

function pod({
  name,
  namespace = "default",
  labels = {},
  of,
  cpu = 10,
  memory = 100,
  phase = "Running",
  state = "running",
}: PodSpec): PodWithMetrics {
  const [kind, owner] = of?.split("/") ?? [];
  return {
    name,
    namespace,
    labels,
    status: { phase },
    containers: [{ state: { type: state } }],
    workload: of ? { kind, name: owner } : null,
    cpuMillicores: cpu,
    memoryBytes: memory,
  } as PodWithMetrics;
}

const usage = (rows: Array<{ name: string; cpuMillicores: number | null }>) =>
  rows.map((row) => [row.name, row.cpuMillicores] as const);

describe("mergePodsWithMetrics", () => {
  const sample = (name: string, cpuMillicores = 10): PodMetrics => ({
    name,
    namespace: "default",
    cpuMillicores,
    memoryBytes: 100,
  });

  /** Fresh metric objects with identical values must not invalidate every pod row memo. */
  it("returns the same row objects when a tick repeats the metric values", () => {
    const pods = [pod({ name: "a" }), pod({ name: "b" })];
    const first = mergePodsWithMetrics(pods, [sample("a"), sample("b")]);
    const next = mergePodsWithMetrics(pods, [sample("b"), sample("a")]);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
  });

  /** CPU or memory changes must reach the affected row without reallocating its neighbours. */
  it.each(["cpuMillicores", "memoryBytes"] as const)(
    "replaces only the row whose %s changed",
    (field) => {
      const pods = [pod({ name: "a" }), pod({ name: "b" })];
      const first = mergePodsWithMetrics(pods, [sample("a"), sample("b")]);
      const next = mergePodsWithMetrics(pods, [
        { ...sample("a"), [field]: 200 },
        sample("b"),
      ]);
      expect(next[0]).not.toBe(first[0]);
      expect(next[0][field]).toBe(200);
      expect(first[0][field]).toBe(field === "cpuMillicores" ? 10 : 100);
      expect(next[1]).toBe(first[1]);
    }
  );

  /** Losing a sample must erase stale usage as unknown, while a measured zero stays zero. */
  it("returns null usage when a pod loses its sample and preserves measured zero", () => {
    const pods = [pod({ name: "a" }), pod({ name: "b" })];
    const zero = { ...sample("b", 0), memoryBytes: 0 };
    const first = mergePodsWithMetrics(pods, [sample("a"), zero]);
    const next = mergePodsWithMetrics(pods, [zero]);
    expect(next[0]).not.toBe(first[0]);
    expect(next[0]).toEqual({
      ...pods[0],
      cpuMillicores: null,
      memoryBytes: null,
    });
    expect(next[1]).toBe(first[1]);
    expect(next[1].cpuMillicores).toBe(0);
    expect(next[1].memoryBytes).toBe(0);
    expect(mergePodsWithMetrics(pods, [zero])[0]).toBe(next[0]);
    expect(
      mergePodsWithMetrics(pods, [sample("a"), zero])[0].cpuMillicores
    ).toBe(10);
  });

  /** A Completed pod's cells drew "no sample yet". Fails if a finished pod is not marked as having nothing to measure, or a running one is. */
  it("marks a finished pod as having nothing to measure, and a running one not", () => {
    const [done, running] = mergePodsWithMetrics(
      [pod({ name: "a", phase: "Succeeded" }), pod({ name: "b" })],
      []
    );
    expect(done).toMatchObject({ idle: true, cpuMillicores: null });
    expect(running.idle).toBeUndefined();
  });

  /**
   * A crash-looping pod's cells drew the warning "no sample yet", as if the
   * read had missed one that was coming. Fails if a pod with no running
   * container and no sample is not marked as having nothing to measure, or if
   * a running pod with no sample yet is.
   */
  it("marks a pod between crashes as having nothing to measure, and a running one with no sample not", () => {
    const [looping, young] = mergePodsWithMetrics(
      [
        pod({ name: "a", state: "waiting", cpu: null, memory: null }),
        pod({ name: "b" }),
      ],
      []
    );
    expect(looping).toMatchObject({ idle: true, cpuMillicores: null });
    expect(young.idle).toBeUndefined();
  });

  /** A cache keyed only by name would hide watch updates or reuse rows from another namespace. */
  it("uses pod identity and namespace when reusing merged rows", () => {
    const pods = [pod({ name: "a" }), pod({ name: "a", namespace: "other" })];
    const metrics = [sample("a"), { ...sample("a", 20), namespace: "other" }];
    const first = mergePodsWithMetrics(pods, metrics);
    const updated = { ...pods[0], restartCount: 3 };
    const next = mergePodsWithMetrics([updated, pods[1]], metrics);
    expect(next[0]).not.toBe(first[0]);
    expect(next[0].restartCount).toBe(3);
    expect(next[0].cpuMillicores).toBe(10);
    expect(next[1]).toBe(first[1]);
    expect(next[1].cpuMillicores).toBe(20);
  });
});

describe("attachAggregatedPodMetrics", () => {
  /** A row is the sum of the pods its workload owns, and of no namesake's in another namespace. */
  it("sums each workload's own pods, a namespace at a time", () => {
    const deployments = [
      { name: "web", namespace: "default" },
      { name: "api", namespace: "default" },
      { name: "web", namespace: "other" },
    ];
    const pods = [
      pod({ name: "web-5d4c-x9", of: "Deployment/web" }),
      pod({ name: "web-5d4c-p2", of: "Deployment/web" }),
      pod({ name: "api-77b-aa", of: "Deployment/api" }),
      pod({ name: "web-5d4c-zz", namespace: "other", of: "Deployment/web" }),
    ];

    expect(
      usage(attachAggregatedPodMetrics(deployments, pods, matchDeploymentPods))
    ).toEqual([
      ["web", 20],
      ["api", 10],
      ["web", 10],
    ]);
  });

  /**
   * `db` beside `db-replica`, `web` beside `web-api` under one `app` label:
   * by name prefix and by label the shorter row showed both summed, and its
   * own page, which reads by owner, showed less. Fails if anything but the
   * owner decides.
   */
  it("gives a sibling's pods to the sibling, whatever their names and labels share", () => {
    const sets = [
      { name: "db", namespace: "default" },
      { name: "db-replica", namespace: "default" },
    ];
    const replicas = [
      pod({ name: "db-0", of: "StatefulSet/db" }),
      pod({ name: "db-replica-0", of: "StatefulSet/db-replica" }),
    ];
    expect(
      usage(attachAggregatedPodMetrics(sets, replicas, matchStatefulSetPods))
    ).toEqual([
      ["db", 10],
      ["db-replica", 10],
    ]);

    const app = { app: "shop" };
    const deployments = [
      { name: "web", namespace: "default", labels: app },
      { name: "web-api", namespace: "default", labels: app },
    ];
    const pods = [
      pod({ name: "web-5d4c-x9", labels: app, of: "Deployment/web" }),
      pod({ name: "web-api-77b-aa", labels: app, of: "Deployment/web-api" }),
    ];
    expect(
      usage(attachAggregatedPodMetrics(deployments, pods, matchDeploymentPods))
    ).toEqual([
      ["web", 10],
      ["web-api", 10],
    ]);
  });

  /** A pod nothing controls, or one another kind controls, is not a row's because of its name. */
  it("leaves a pod it does not own out, though it is named like one of its own", () => {
    const deployments = [{ name: "web", namespace: "default" }];
    const pods = [
      pod({ name: "web-5d4c-x9" }),
      pod({ name: "web-0", of: "StatefulSet/web" }),
    ];

    expect(
      attachAggregatedPodMetrics(deployments, pods, matchDeploymentPods)[0]
        .cpuMillicores
    ).toBeNull();
  });

  /**
   * A pod names its Job and nothing above it, so a CronJob's are found by
   * the name its controller gives a run. Fails if `backup` takes the runs
   * of `backup-nightly`, or a Job that only starts the same.
   */
  it("sums a CronJob's scheduled runs and no sibling's", () => {
    const crons = [
      { name: "backup", namespace: "default" },
      { name: "backup-nightly", namespace: "default" },
    ];
    const pods = [
      pod({ name: "backup-28901234-vk2mn", of: "Job/backup-28901234" }),
      pod({
        name: "backup-nightly-28901235-x8k2j",
        of: "Job/backup-nightly-28901235",
      }),
      pod({ name: "backup-verify-zz4kq", of: "Job/backup-verify" }),
      pod({ name: "backup-web-5d4c-x9", of: "Deployment/backup-web" }),
    ];

    expect(
      usage(attachAggregatedPodMetrics(crons, pods, matchCronJobPods))
    ).toEqual([
      ["backup", 10],
      ["backup-nightly", 10],
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

  /**
   * A Deployment at 0/0 read "0m" and "0 B", a measured zero,
   * where its page said nothing runs. Fails if a workload with no pods is
   * not marked as having nothing to measure once the pods were read, or is
   * marked so when they were not.
   */
  it("says a workload with no pods has nothing to measure once the pods were read, and stays unknown when they were not", () => {
    const sets = [{ name: "idle", namespace: "shop" }];
    expect(
      attachAggregatedPodMetrics(sets, [], matchStatefulSetPods, true)[0]
    ).toMatchObject({ cpuMillicores: null, memoryBytes: null, idle: true });
    expect(
      attachAggregatedPodMetrics(sets, [], matchStatefulSetPods)[0].idle
    ).toBeUndefined();
  });

  /** Fails if a finished pod is summed into its workload, which then draws "no sample yet" for a Job that is done. */
  it("counts only running pods, so a workload whose pods all finished has nothing to measure", () => {
    const jobs = [{ name: "migrate", namespace: "default" }];
    const pods = [
      pod({
        name: "migrate-a",
        of: "Job/migrate",
        phase: "Succeeded",
        cpu: null,
      }),
      pod({ name: "migrate-b", of: "Job/migrate", phase: "Failed", cpu: null }),
    ];
    expect(
      attachAggregatedPodMetrics(
        jobs,
        pods,
        (p) => p.workload?.name ?? null,
        true
      )[0]
    ).toMatchObject({ cpuMillicores: null, idle: true });
  });

  /** Fails if a workload whose every pod is between crashes draws the unread mark its pods no longer draw. */
  it("says a workload whose pods all run nothing has nothing to measure", () => {
    const jobs = [{ name: "api", namespace: "default" }];
    const [looping] = mergePodsWithMetrics(
      [
        pod({
          name: "api-a",
          of: "Job/api",
          state: "waiting",
          cpu: null,
          memory: null,
        }),
      ],
      []
    );
    expect(
      attachAggregatedPodMetrics(
        jobs,
        [looping],
        (p) => p.workload?.name ?? null,
        true
      )[0]
    ).toMatchObject({ cpuMillicores: null, idle: true });
  });
});
