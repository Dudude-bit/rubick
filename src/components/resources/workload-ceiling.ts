/**
 * What a controller's pod template says one replica may take — the ceiling a
 * Usage chart draws against. Kept out of `workload-usage.tsx` so the component
 * file exports only its component (react-refresh), and so a test can reach
 * this directly.
 */
import {
  declaredContainers,
  type ContainerLists,
} from "@/lib/container-sequence";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import type {
  DeploymentContainerInfo,
  DeploymentContainerResources,
} from "@/generated/types";

/**
 * A pod template, as a workload page hands it to the Usage block: its declared
 * containers plus the pod-level resources (KEP-2837) the `PodSpec` may carry.
 */
export type WorkloadTemplate = ContainerLists<DeploymentContainerInfo> & {
  podResources?: DeploymentContainerResources | null;
};

/**
 * What a template says one replica may take, or null where it says nothing.
 *
 * Sidecars count, ordinary init containers do not: a native sidecar runs for
 * the life of the pod, so the scheduler adds its request to the app
 * containers' and the ceiling a chart draws has to match. An ordinary init
 * container has exited before any of this is measured.
 */
export function templateCeiling(
  template: WorkloadTemplate | null | undefined
): {
  cpu: number | null;
  memory: number | null;
} {
  if (!template) return { cpu: null, memory: null };

  let cpu = 0;
  let memory = 0;
  for (const container of declaredContainers(template)) {
    if (container.phase === "init") continue;
    const limits = container.resources?.limits;
    if (limits?.cpu) cpu += parseCPU(limits.cpu);
    if (limits?.memory) memory += parseMemory(limits.memory);
  }

  // KEP-2837: a pod-level limit, where the template declares one, is the
  // replica's ceiling in place of the container sum — per resource, exactly as
  // PodInfo does it. Without this the workload page would say "no limits" while
  // every pod it owns shows one.
  const podLimits = template.podResources?.limits;
  return {
    cpu: podLimits?.cpu ? parseCPU(podLimits.cpu) : cpu > 0 ? cpu : null,
    memory: podLimits?.memory
      ? parseMemory(podLimits.memory)
      : memory > 0
        ? memory
        : null,
  };
}
