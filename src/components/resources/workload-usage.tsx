/**
 * The Usage block on a controller's page.
 *
 * A Deployment, StatefulSet, DaemonSet, Job or CronJob consumes nothing
 * itself — its pods do. So every one of them asks the same two questions:
 * which pods are mine, and are any of them running. This holds the answer to
 * the second one, in one place, so that "nothing is running" cannot be drawn
 * as a chart on one kind and said in words on another.
 *
 * The block itself is {@link UsageBlock}, unchanged and unforked: a Pod, a
 * Node and a Deployment must not disagree about what a chart of CPU looks
 * like. What is here is only the summing and the honesty about zero.
 */
import { useMemo } from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { UsageBlock } from "@/components/resources/usage-block";
import { useMetrics } from "@/hooks/useMetrics";
import {
  declaredContainers,
  type ContainerLists,
} from "@/lib/container-sequence";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { aggregatePodMetrics, mergePodsWithMetrics } from "@/lib/metrics";
import type {
  DeploymentContainerInfo,
  PodInfo,
  ResourceConnections,
} from "@/generated/types";

/**
 * What a template says one replica may take, or null where it says nothing.
 *
 * Sidecars count, ordinary init containers do not: a native sidecar runs for
 * the life of the pod, so the scheduler adds its request to the app
 * containers' and the ceiling a chart draws has to match. An ordinary init
 * container has exited before any of this is measured.
 */
function templateCeiling(
  template: ContainerLists<DeploymentContainerInfo> | null | undefined
): { cpu: number | null; memory: number | null } {
  if (!template) return { cpu: null, memory: null };

  let cpu = 0;
  let memory = 0;
  for (const container of declaredContainers(template)) {
    if (container.phase === "init") continue;
    const limits = container.resources?.limits;
    if (limits?.cpu) cpu += parseCPU(limits.cpu);
    if (limits?.memory) memory += parseMemory(limits.memory);
  }

  return { cpu: cpu > 0 ? cpu : null, memory: memory > 0 ? memory : null };
}

/**
 * A pod that has terminated is not using anything, and metrics-server has
 * dropped it — a Job's four `Completed` pods are four rows in its Pods tab
 * and zero contributors here.
 */
function runningPods(pods: readonly PodInfo[]): PodInfo[] {
  return pods.filter(
    (pod) => pod.status.phase !== "Succeeded" && pod.status.phase !== "Failed"
  );
}

const NO_LIMITS_NOTE =
  "No limits declared on this template — the scale is what these pods have used, and nothing caps what they can take.";

export interface WorkloadUsageProps {
  kind: string;
  uid: string | null | undefined;
  namespace: string | null | undefined;
  /** The pod template, which is where a controller's limits are declared. */
  template: ContainerLists<DeploymentContainerInfo> | null | undefined;
  /** Every pod the page found, exited ones included. */
  pods: readonly PodInfo[];
  /**
   * Why there is nothing to measure, in this kind's own words — a Job that
   * finished and a CronJob between runs are both at zero for reasons a reader
   * would act on differently.
   */
  idle: string;
  connections?: ResourceConnections | null;
  noLimitNote?: string;
}

export function WorkloadUsage({
  kind,
  uid,
  namespace,
  template,
  pods,
  idle,
  connections,
  noLimitNote = NO_LIMITS_NOTE,
}: WorkloadUsageProps) {
  const running = useMemo(() => runningPods(pods), [pods]);

  const { podMetrics, podStatus, podSampledAt } = useMetrics({
    namespace: namespace || null,
    includeNodes: false,
    includeCluster: false,
    enabled: running.length > 0,
  });

  const withMetrics = useMemo(
    () => mergePodsWithMetrics(running, podMetrics),
    [running, podMetrics]
  );
  const summed = useMemo(() => aggregatePodMetrics(withMetrics), [withMetrics]);

  if (running.length === 0) return <IdleUsage says={idle} />;

  // Per replica in the template, so the ceiling is scaled to the same pods
  // the reading is summed over — a workload halfway through a rollout is
  // measured against what is actually there rather than against what was
  // asked for.
  const ceiling = templateCeiling(template);

  return (
    <UsageBlock
      kind={kind}
      uid={uid}
      scope={`summed over ${running.length} pod${running.length === 1 ? "" : "s"}`}
      cpu={summed.cpuMillicores}
      memory={summed.memoryBytes}
      cpuLimit={ceiling.cpu === null ? null : ceiling.cpu * running.length}
      memoryLimit={
        ceiling.memory === null ? null : ceiling.memory * running.length
      }
      noLimitNote={noLimitNote}
      restarts={withMetrics.reduce((total, pod) => total + pod.restartCount, 0)}
      sampledAt={podSampledAt}
      status={podStatus}
      connections={connections}
    />
  );
}

/**
 * Nothing running, said rather than drawn.
 *
 * An empty chart is a claim that something was measured and came back at
 * zero. A finished Job and a suspended CronJob were not measured at all, and
 * the difference is the whole point: a line along the floor invites someone
 * to ask why the workload is idle, when the answer is that it is not there.
 */
function IdleUsage({ says }: { says: string }) {
  return (
    <Section>
      <SectionHeader title="Usage" count="nothing running" />
      <p className="px-1.5 pt-1 text-[11px] leading-snug text-fg-fnt">
        {says} Usage is summed from running pods, and metrics-server keeps
        nothing about a pod that has exited — so there is no line rather than a
        line at zero.
      </p>
    </Section>
  );
}
