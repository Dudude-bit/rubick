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
import { useCapabilityState } from "@/integrations";
import { useMetrics } from "@/hooks/useMetrics";
import {
  declaredContainers,
  type ContainerLists,
} from "@/lib/container-sequence";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { aggregatePodMetrics, mergePodsWithMetrics } from "@/lib/metrics";
import type { UsageScope } from "@/integrations";
import { useT } from "@/i18n/useT";
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
  /**
   * The controller's own name — what a history supplier is asked about.
   *
   * The controller and not its pods, deliberately: the pods it had an hour
   * ago are gone from every list the API server will answer, and their
   * ReplicaSet hash changed at the last rollout. Naming the controller is
   * what lets a range span the generations it has had.
   */
  name?: string | null;
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
  name,
  namespace,
  template,
  pods,
  idle,
  connections,
  noLimitNote = NO_LIMITS_NOTE,
}: WorkloadUsageProps) {
  const t = useT();
  const running = useMemo(() => runningPods(pods), [pods]);

  const { podMetrics, podStatus, podSampledAt } = useMetrics({
    namespace: namespace || null,
    includeNodes: false,
    enabled: running.length > 0,
  });

  const withMetrics = useMemo(
    () => mergePodsWithMetrics(running, podMetrics),
    [running, podMetrics]
  );
  const summed = useMemo(() => aggregatePodMetrics(withMetrics), [withMetrics]);

  // Per replica in the template, so the ceiling is scaled to the same pods
  // the reading is summed over — a workload halfway through a rollout is
  // measured against what is actually there rather than against what was
  // asked for.
  const ceiling = templateCeiling(template);

  const scope: UsageScope | undefined =
    name && namespace
      ? { kind: "workload", namespace, owner: name, ownerKind: kind }
      : undefined;

  // The one case metrics-server and a Prometheus disagree about. Both are
  // right that nothing is running; only one of them still holds what ran.
  const past = useCapabilityState("usage.history");

  if (running.length === 0) {
    if (past.state !== "ready" || scope === undefined) {
      return <IdleUsage says={idle} />;
    }
    return (
      <UsageBlock
        kind={kind}
        uid={uid}
        scope={t("empty", "nothingRunning")}
        cpu={null}
        memory={null}
        // The template's ceiling for one replica, unmultiplied: there are no
        // pods to scale it by, and scaling by zero would erase a limit the
        // template does declare and print "no limits declared" under it.
        cpuLimit={ceiling.cpu}
        memoryLimit={ceiling.memory}
        noLimitNote={noLimitNote}
        sampledAt={null}
        status={null}
        connections={connections}
        history={scope}
        live={false}
        idleNote={idle}
      />
    );
  }

  return (
    <UsageBlock
      kind={kind}
      uid={uid}
      scope={t("count", "summedOverPods", { n: running.length })}
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
      history={scope}
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
  const t = useT();
  return (
    <Section>
      <SectionHeader title="Usage" count={t("empty", "nothingRunning")} />
      <p className="px-1.5 pt-1 text-[11px] leading-snug text-fg-fnt">
        {says} {t("empty", "usageIdleNote")}
      </p>
    </Section>
  );
}
