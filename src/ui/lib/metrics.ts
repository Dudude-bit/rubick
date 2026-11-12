import type { PodMetrics, NodeMetrics, NodeInfo } from "@/generated/types";
import type { PodRow } from "@/lib/pod-rows";

export interface PodWithMetrics extends PodRow {
  cpuMillicores: number | null;
  memoryBytes: number | null;
}

export interface NodeWithMetrics extends NodeInfo {
  cpuMillicores: number | null;
  memoryBytes: number | null;
}

export interface ResourceMetrics {
  cpuMillicores: number | null;
  memoryBytes: number | null;
}

const podRows = new WeakMap<PodRow, PodWithMetrics>();

export function mergePodsWithMetrics(
  pods: PodRow[],
  metrics: PodMetrics[]
): PodWithMetrics[] {
  const metricsByKey = new Map<string, PodMetrics>();
  for (const metric of metrics) {
    metricsByKey.set(`${metric.namespace}/${metric.name}`, metric);
  }

  return pods.map((pod) => {
    const metric = metricsByKey.get(`${pod.namespace}/${pod.name}`);
    const cpuMillicores = metric?.cpuMillicores ?? null;
    const memoryBytes = metric?.memoryBytes ?? null;
    const cached = podRows.get(pod);
    if (
      cached &&
      cached.cpuMillicores === cpuMillicores &&
      cached.memoryBytes === memoryBytes
    ) {
      return cached;
    }
    const row = {
      ...pod,
      cpuMillicores,
      memoryBytes,
    };
    podRows.set(pod, row);
    return row;
  });
}

export function mergeNodesWithMetrics(
  nodes: NodeInfo[],
  metrics: NodeMetrics[]
): NodeWithMetrics[] {
  const metricsByName = new Map<string, NodeMetrics>();
  for (const metric of metrics) {
    metricsByName.set(metric.name, metric);
  }

  return nodes.map((node) => {
    const metric = metricsByName.get(node.name);
    return {
      ...node,
      cpuMillicores: metric?.cpuMillicores ?? null,
      memoryBytes: metric?.memoryBytes ?? null,
    };
  });
}

export function aggregatePodMetrics(
  metrics: Array<{ cpuMillicores?: number | null; memoryBytes?: number | null }>
): ResourceMetrics {
  let totalCpu = 0;
  let totalMemory = 0;
  let hasCpu = false;
  let hasMemory = false;

  for (const metric of metrics) {
    if (metric.cpuMillicores !== null && metric.cpuMillicores !== undefined) {
      hasCpu = true;
      totalCpu += metric.cpuMillicores;
    }
    if (metric.memoryBytes !== null && metric.memoryBytes !== undefined) {
      hasMemory = true;
      totalMemory += metric.memoryBytes;
    }
  }

  return {
    cpuMillicores: hasCpu ? totalCpu : null,
    memoryBytes: hasMemory ? totalMemory : null,
  };
}

/**
 * Which workload of a list's kind a pod is summed under, by name, or null
 * where it is none of theirs.
 */
export type PodOwner = (pod: Pick<PodRow, "workload">) => string | null;

// The separator is a character no Kubernetes name can contain.
const key = (namespace: string, name: string) => `${namespace}\u0000${name}`;

/**
 * Sum each workload's pods' usage onto the workload row.
 *
 * Indexed, not filtered: `pods.filter(matches)` per workload is
 * `workloads × pods` comparisons, and this runs again on every pod
 * event — 200 Deployments against 2000 pods is 400 000 matches per kubelet
 * heartbeat, on the main thread, for a table nobody has touched. The same
 * answer comes out of one pass over the pods and one lookup per workload.
 */
export function attachAggregatedPodMetrics<
  T extends { name: string; namespace: string },
>(
  resources: T[],
  pods: PodWithMetrics[],
  ownerOf: PodOwner
): Array<T & ResourceMetrics> {
  const byOwner = new Map<string, PodWithMetrics[]>();
  for (const pod of pods) {
    const owner = ownerOf(pod);
    if (owner === null) continue;
    const at = key(pod.namespace, owner);
    const own = byOwner.get(at);
    if (own) own.push(pod);
    else byOwner.set(at, [pod]);
  }

  return resources.map((resource) => {
    const own = byOwner.get(key(resource.namespace, resource.name)) ?? [];
    const aggregated = aggregatePodMetrics(own);
    return {
      ...resource,
      cpuMillicores: aggregated.cpuMillicores,
      memoryBytes: aggregated.memoryBytes,
    };
  });
}

/**
 * A pod is its controller's: the workload Rust read off its owner reference,
 * a Deployment's through its ReplicaSet, as the row's verdict and its page
 * count them. Read off the pod's name instead, by every prefix ending before
 * a `-`, StatefulSet `db` was shown `db` and `db-replica` summed.
 */
const ownedBy =
  (kind: string): PodOwner =>
  (pod) =>
    pod.workload?.kind === kind ? pod.workload.name : null;

export const matchDeploymentPods = ownedBy("Deployment");
export const matchStatefulSetPods = ownedBy("StatefulSet");
export const matchDaemonSetPods = ownedBy("DaemonSet");
export const matchJobPods = ownedBy("Job");

/**
 * A CronJob's pods name their Job and nothing above it, so the Job's name is
 * read exactly as the controller writes it: `<cronjob>-<minute>`.
 */
export const matchCronJobPods: PodOwner = (pod) =>
  pod.workload?.kind === "Job"
    ? (/^(.+)-\d+$/.exec(pod.workload.name)?.[1] ?? null)
    : null;
