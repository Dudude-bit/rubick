import type {
  PodMetrics,
  NodeMetrics,
  PodInfo,
  NodeInfo,
} from "@/generated/types";
import { parseCPU, parseMemory } from "./k8s-quantity";

export interface PodWithMetrics extends PodInfo {
  cpuMillicores: number | null;
  memoryBytes: number | null;
}

export interface PodWithMetricsAndResources extends PodWithMetrics {
  aggregatedResources: AggregatedResources;
}

export interface NodeWithMetrics extends NodeInfo {
  cpuMillicores: number | null;
  memoryBytes: number | null;
}

export interface ResourceMetrics {
  cpuMillicores: number | null;
  memoryBytes: number | null;
}

export function mergePodsWithMetrics(
  pods: PodInfo[],
  metrics: PodMetrics[]
): PodWithMetrics[] {
  const metricsByKey = new Map<string, PodMetrics>();
  for (const metric of metrics) {
    metricsByKey.set(`${metric.namespace}/${metric.name}`, metric);
  }

  return pods.map((pod) => {
    const metric = metricsByKey.get(`${pod.namespace}/${pod.name}`);
    return {
      ...pod,
      cpuMillicores: metric?.cpuMillicores ?? null,
      memoryBytes: metric?.memoryBytes ?? null,
    };
  });
}

/**
 * Merge pods with metrics AND parse resource specs
 */
export function mergePodsWithMetricsAndResources(
  pods: PodInfo[],
  metrics: PodMetrics[]
): PodWithMetricsAndResources[] {
  const withMetrics = mergePodsWithMetrics(pods, metrics);

  return withMetrics.map((pod) => ({
    ...pod,
    aggregatedResources: aggregatePodResources(pod),
  }));
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
 * Sum each workload's pods' usage onto the workload row.
 *
 * Indexed, not filtered: `pods.filter(matches)` per workload is
 * `workloads × pods` comparisons, and this runs again on every pod
 * event — 200 Deployments against 2000 pods is 400 000 selector matches
 * per kubelet heartbeat, on the main thread, for a table nobody has
 * touched. The same answer comes out of one pass over the pods and one
 * lookup per workload.
 */
export function attachAggregatedPodMetrics<
  T extends { name: string; namespace: string },
>(
  resources: T[],
  pods: PodWithMetrics[],
  matcher: PodMatcher
): Array<T & ResourceMetrics> {
  const { keysOf, keysOfPod } = matcher.ownership;

  const podsByKey = new Map<string, PodWithMetrics[]>();
  for (const pod of pods) {
    for (const key of keysOfPod(pod)) {
      const bucket = podsByKey.get(key);
      if (bucket) bucket.push(pod);
      else podsByKey.set(key, [pod]);
    }
  }

  return resources.map((resource) => {
    const keys = keysOf(resource);
    // A Deployment claims its pods by several keys at once, and one pod
    // can answer to more than one of them — counting it twice would
    // double the row's usage.
    const matchedPods =
      keys.length === 1
        ? (podsByKey.get(keys[0]) ?? [])
        : [...new Set(keys.flatMap((key) => podsByKey.get(key) ?? []))];
    const aggregated = aggregatePodMetrics(matchedPods);
    return {
      ...resource,
      cpuMillicores: aggregated.cpuMillicores,
      memoryBytes: aggregated.memoryBytes,
    };
  });
}

export function getTopPodsByCPU(
  pods: Array<{
    name: string;
    namespace?: string | null;
    cpuMillicores?: number | null;
  }>,
  limit: number = 5
): Array<{ name: string; namespace: string; cpuMillicores: number }> {
  return pods
    .filter(
      (pod) => pod.cpuMillicores !== null && pod.cpuMillicores !== undefined
    )
    .map((pod) => ({
      name: pod.name,
      namespace: pod.namespace ?? "default",
      cpuMillicores: pod.cpuMillicores as number,
    }))
    .sort((a, b) => b.cpuMillicores - a.cpuMillicores)
    .slice(0, limit);
}

export function getTopPodsByMemory(
  pods: Array<{
    name: string;
    namespace?: string | null;
    memoryBytes?: number | null;
  }>,
  limit: number = 5
): Array<{ name: string; namespace: string; memoryBytes: number }> {
  return pods
    .filter((pod) => pod.memoryBytes !== null && pod.memoryBytes !== undefined)
    .map((pod) => ({
      name: pod.name,
      namespace: pod.namespace ?? "default",
      memoryBytes: pod.memoryBytes as number,
    }))
    .sort((a, b) => b.memoryBytes - a.memoryBytes)
    .slice(0, limit);
}

/** The parts of a workload row that decide which pods are its own. */
export interface WorkloadRef {
  name: string;
  namespace: string;
  labels?: Record<string, string> | null;
}

/**
 * Which pods belong to a workload, expressed as keys both sides can be
 * indexed by rather than as a predicate over every pair.
 *
 * A pod belongs to a workload when they share a key. Namespace is part
 * of every key, so a workload can never reach across one.
 */
export interface PodOwnership {
  keysOf: (workload: WorkloadRef) => string[];
  keysOfPod: (pod: PodInfo) => string[];
}

/**
 * The same rule in both forms it is needed in: callable, for the detail
 * pages that ask it about one pod, and indexable, for the list pages
 * that ask it about every pod at once. Hanging one off the other is what
 * keeps them from drifting into two definitions of "belongs to".
 */
export type PodMatcher = ((workload: WorkloadRef, pod: PodInfo) => boolean) & {
  readonly ownership: PodOwnership;
};

// Namespace, then which kind of key, then the value. The separator is a
// character no Kubernetes name or label value can contain, so no two
// keys can collide by concatenation.
const key = (namespace: string, kind: string, value: string) =>
  `${namespace}\u0000${kind}\u0000${value}`;

/**
 * Every name a pod could have been generated from: `web-5d4c-x9` could
 * belong to `web` or to `web-5d4c`, and to nothing else.
 */
function nameKeysOfPod(pod: PodInfo): string[] {
  const keys: string[] = [];
  for (let i = 0; i < pod.name.length; i++) {
    if (pod.name[i] === "-") {
      keys.push(key(pod.namespace, "name", pod.name.slice(0, i)));
    }
  }
  return keys;
}

function matcher(ownership: PodOwnership): PodMatcher {
  const predicate = (workload: WorkloadRef, pod: PodInfo) => {
    const keys = new Set(ownership.keysOf(workload));
    return ownership.keysOfPod(pod).some((podKey) => keys.has(podKey));
  };
  return Object.assign(predicate, { ownership });
}

/**
 * Controllers that name their pods after themselves: a StatefulSet, a
 * DaemonSet, a Job, a CronJob's Jobs.
 */
const byGeneratedName: PodOwnership = {
  keysOf: (workload) => [key(workload.namespace, "name", workload.name)],
  keysOfPod: nameKeysOfPod,
};

/**
 * A Deployment reaches its pods through its ReplicaSet, so the pod name
 * carries an extra segment and the labels are the more reliable link.
 *
 * `app` is matched only when both sides carry it: two objects that are
 * both unlabelled are not thereby the same app, and treating them as one
 * summed every unlabelled pod in the namespace onto every unlabelled
 * Deployment row.
 */
const byDeploymentSelector: PodOwnership = {
  keysOf: (workload) => {
    const keys = [key(workload.namespace, "name", workload.name)];
    const app = workload.labels?.app;
    if (app) keys.push(key(workload.namespace, "app", app));
    return keys;
  },
  keysOfPod: (pod) => {
    const keys = nameKeysOfPod(pod);
    const owner = pod.labels?.deployment;
    if (owner) keys.push(key(pod.namespace, "name", owner));
    const app = pod.labels?.app;
    if (app) keys.push(key(pod.namespace, "app", app));
    return keys;
  },
};

export const matchStatefulSetPods = matcher(byGeneratedName);
export const matchDaemonSetPods = matcher(byGeneratedName);
export const matchJobPods = matcher(byGeneratedName);
export const matchCronJobPods = matcher(byGeneratedName);
export const matchDeploymentPods = matcher(byDeploymentSelector);

/**
 * Aggregated resource values in parsed form
 */
export interface AggregatedResources {
  cpuRequest: number | null;
  cpuLimit: number | null;
  memoryRequest: number | null;
  memoryLimit: number | null;
}

/**
 * Aggregate resource requests and limits from a pod
 *
 * @param pod - Pod with cpuRequests, cpuLimits, memoryRequests, memoryLimits
 * @returns Parsed resource values
 */
export function aggregatePodResources(pod: {
  cpuRequests?: string | null;
  cpuLimits?: string | null;
  memoryRequests?: string | null;
  memoryLimits?: string | null;
}): AggregatedResources {
  return {
    cpuRequest: pod.cpuRequests ? parseCPU(pod.cpuRequests) : null,
    cpuLimit: pod.cpuLimits ? parseCPU(pod.cpuLimits) : null,
    memoryRequest: pod.memoryRequests ? parseMemory(pod.memoryRequests) : null,
    memoryLimit: pod.memoryLimits ? parseMemory(pod.memoryLimits) : null,
  };
}

/**
 * Aggregate resources across multiple pods
 *
 * @param pods - Array of pods with resource specs
 * @returns Summed resource values
 */
export function aggregateMultiplePodResources(
  pods: Array<{
    cpuRequests?: string | null;
    cpuLimits?: string | null;
    memoryRequests?: string | null;
    memoryLimits?: string | null;
  }>
): AggregatedResources {
  let cpuRequest = 0;
  let cpuLimit = 0;
  let memoryRequest = 0;
  let memoryLimit = 0;
  let hasCpuRequest = false;
  let hasCpuLimit = false;
  let hasMemoryRequest = false;
  let hasMemoryLimit = false;

  for (const pod of pods) {
    if (pod.cpuRequests) {
      hasCpuRequest = true;
      cpuRequest += parseCPU(pod.cpuRequests);
    }
    if (pod.cpuLimits) {
      hasCpuLimit = true;
      cpuLimit += parseCPU(pod.cpuLimits);
    }
    if (pod.memoryRequests) {
      hasMemoryRequest = true;
      memoryRequest += parseMemory(pod.memoryRequests);
    }
    if (pod.memoryLimits) {
      hasMemoryLimit = true;
      memoryLimit += parseMemory(pod.memoryLimits);
    }
  }

  return {
    cpuRequest: hasCpuRequest ? cpuRequest : null,
    cpuLimit: hasCpuLimit ? cpuLimit : null,
    memoryRequest: hasMemoryRequest ? memoryRequest : null,
    memoryLimit: hasMemoryLimit ? memoryLimit : null,
  };
}
