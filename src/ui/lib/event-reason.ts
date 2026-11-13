import {
  CircleDashed,
  CloudDownload,
  Cpu,
  Disc3,
  HeartPulse,
  MapPin,
  Power,
  Repeat,
  type LucideIcon,
} from "lucide-react";

/**
 * What an event reason is *about*.
 *
 * Kubernetes' reason vocabulary is long but finite, written by a handful of
 * components that each talk about one thing: the kubelet's image manager, its
 * container lifecycle, the scheduler, a workload controller, the probe runner,
 * the volume manager, the node status loop. Colouring per reason string would
 * mean thirty hues nobody can hold; per family it is seven, and the reason
 * text still says exactly which one it is.
 */
export type EventFamily =
  | "image"
  | "lifecycle"
  | "scheduling"
  | "controller"
  | "health"
  | "storage"
  | "node";

const FAMILY_ICON: Record<EventFamily, LucideIcon> = {
  image: CloudDownload,
  lifecycle: Power,
  scheduling: MapPin,
  controller: Repeat,
  health: HeartPulse,
  storage: Disc3,
  node: Cpu,
};

const REASONS: Record<EventFamily, readonly string[]> = {
  image: [
    "Pulling",
    "Pulled",
    // Ambiguous by design in kubelet: the same "Failed" covers a pull, a
    // create and a start. It is always a Warning, so the hue is suppressed
    // either way and only the glyph is a guess.
    "Failed",
    "InspectFailed",
    "ErrImagePull",
    "ErrImageNeverPull",
    "BackOff",
    "ImageGCFailed",
    "FailedToPullImage",
  ],
  lifecycle: [
    "Created",
    "Started",
    "Killing",
    "Completed",
    "Preempting",
    "Stopping",
    "SandboxChanged",
    "FailedCreatePodSandBox",
    "FailedPodSandBoxStatus",
    "FailedKillPod",
    "FailedSync",
    "ExceededGracePeriod",
    "ExecCommandFailed",
    "ContainerGCFailed",
    "OOMKilling",
    "CrashLoopBackOff",
    "CrashLooping",
  ],
  scheduling: [
    "Scheduled",
    "FailedScheduling",
    "Preempted",
    "TriggeredScaleUp",
    "NotTriggerScaleUp",
    "FailedToTriggerScaleUp",
    "ScaleDown",
    "ScaleDownEmpty",
    "Evicted",
    "EvictionThresholdMet",
    "TaintManagerEviction",
    "Unschedulable",
  ],
  controller: [
    "SuccessfulCreate",
    "SuccessfulDelete",
    "FailedCreate",
    "FailedDelete",
    "ScalingReplicaSet",
    "SuccessfulRescale",
    "FailedGetScale",
    "FailedGetResourceMetric",
    "FailedComputeMetricsReplicas",
    "ReplicaSetCreateError",
    "DeploymentRollback",
    "DeploymentRollbackFailed",
    "SelectorRequired",
    "SawCompletedJob",
    "MissingJob",
    "UnexpectedJob",
    "JobAlreadyActive",
    "FailedNeedsStart",
    "BackoffLimitExceeded",
    "DeadlineExceeded",
    "FailedDaemonPod",
  ],
  health: [
    "Unhealthy",
    "ProbeWarning",
    "ContainerProbeWarning",
    "LivenessProbeFailed",
    "ReadinessProbeFailed",
    "StartupProbeFailed",
  ],
  storage: [
    "Provisioning",
    "ProvisioningSucceeded",
    "ProvisioningFailed",
    "ProvisioningCleanupFailed",
    "ExternalProvisioning",
    "WaitForFirstConsumer",
    "WaitForPodScheduled",
    "FailedBinding",
    "FailedMount",
    "FailedUnMount",
    "FailedMapVolume",
    "FailedAttachVolume",
    "FailedDetachVolume",
    "SuccessfulAttachVolume",
    "SuccessfulDetachVolume",
    "SuccessfulMountVolume",
    "VolumeResizeFailed",
    "VolumeResizeSuccessful",
    "FileSystemResizeRequired",
    "FileSystemResizeSuccessful",
    "NodeExpansionFailed",
    "ClaimLost",
    "RecyclerPod",
  ],
  node: [
    "NodeReady",
    "NodeNotReady",
    "NodeSchedulable",
    "NodeNotSchedulable",
    "NodeHasSufficientMemory",
    "NodeHasInsufficientMemory",
    "NodeHasMemoryPressure",
    "NodeHasNoDiskPressure",
    "NodeHasDiskPressure",
    "NodeHasSufficientPID",
    "NodeHasPIDPressure",
    "NodeAllocatableEnforced",
    "RegisteredNode",
    "RemovingNode",
    "DeletingNode",
    "CIDRNotAvailable",
    "Rebooted",
    "Starting",
    "KubeletSetupFailed",
    "InvalidDiskCapacity",
  ],
};

const LOOKUP = new Map<string, EventFamily>(
  Object.entries(REASONS).flatMap(([family, reasons]) =>
    reasons.map((reason) => [reason.toLowerCase(), family as EventFamily])
  )
);

export interface EventReasonMark {
  family: EventFamily | null;
  Icon: LucideIcon;
}

/**
 * Operators and CRDs invent reasons no list will ever hold, so an unmatched
 * one is answered deliberately rather than hashed into whichever family it
 * happens to collide with: a dashed circle — the same "not in the registry"
 * mark `ResourceRef` gives an unknown kind — and no hue at all, which is the
 * one appearance guaranteed not to assert something false.
 */
export function eventReasonMark(reason: string | null): EventReasonMark {
  const family = reason ? (LOOKUP.get(reason.toLowerCase()) ?? null) : null;
  if (!family) return { family: null, Icon: CircleDashed };
  return {
    family,
    Icon: FAMILY_ICON[family],
  };
}

/**
 * A reason cut where it may break: between the words of its CamelCase, so
 * `SuccessfulCreate` wraps as Successful, Create and never reads as `Succ…`.
 * The pieces join back to the reason exactly.
 */
export function reasonWords(reason: string): string[] {
  return reason.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[^A-Za-z0-9]+/g) ?? [];
}
