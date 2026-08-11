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
 * Kubernetes' reason vocabulary is long but finite, and it is written by a
 * handful of components that each talk about one thing: the kubelet's image
 * manager, its container lifecycle, the scheduler, a workload controller, the
 * probe runner, the volume manager, the node status loop. Colouring per reason
 * string would mean thirty hues nobody can hold; colouring per family means
 * seven, and the reason text is still there to say exactly which one it is.
 */
export type EventFamily =
  | "image"
  | "lifecycle"
  | "scheduling"
  | "controller"
  | "health"
  | "storage"
  | "node";

/**
 * Hues, on the same terms as `resource-identity`: the number lives here,
 * `--evt-s` / `--evt-l` live in `index.css` so both themes track their own
 * canvas without a `dark:` branch anywhere.
 *
 * Red through yellow (roughly 0-60) is excluded for the reason it is excluded
 * from the identity ring — that band is `--warn` and `--err`, and a family
 * that borrowed it would claim a severity the event does not have. The green
 * around 148 is left out too: it is `--ok`, and `Killing` in success-green is
 * a worse lie than no colour at all.
 *
 * The four families the cluster emits constantly — lifecycle, scheduling,
 * image, controller — take the widest gaps between them (65 degrees and up).
 * The three that appear in bursts fill in between. `health` sits closest to a
 * neighbour on purpose: nearly every reason in it is a Warning, so its hue is
 * the one that renders least.
 */
const FAMILY_HUE: Record<EventFamily, number> = {
  controller: 104,
  health: 172,
  lifecycle: 198,
  node: 235,
  scheduling: 262,
  storage: 296,
  image: 330,
};

/**
 * Shape is the channel that survives greyscale and the reader who cannot
 * separate the hues, so these are picked to differ in outline rather than in
 * theme: a cloud, a power ring, a pin, two arrows, a heart, a platter, a chip.
 *
 * Two constraints beyond that. No family gets a triangle — that outline is the
 * severity mark one column to the left and has to stay unambiguous. And none
 * of them may be an icon `RESOURCE_REGISTRY` already spends on a kind: an
 * event row shows the family glyph and the involved object's kind glyph eight
 * pixels apart, so the obvious picks — Package next to Pod's Box, Layers next
 * to Deployment's Layers, Database next to StatefulSet's — read as one mark
 * repeated rather than two channels.
 */
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
  /** `null` where nothing is known, so the caller falls back to a role token. */
  color: string | null;
}

/**
 * Operators and CRDs invent reasons no list will ever hold, so an unmatched
 * one is answered deliberately rather than hashed into whichever family it
 * happens to collide with: a dashed circle — the same "not in the registry"
 * mark `ResourceRef` gives an unknown kind — and no hue at all. Unknown then
 * looks exactly like the feed looked before any of this existed, which is the
 * one appearance guaranteed not to assert something false.
 */
export function eventReasonMark(reason: string | null): EventReasonMark {
  const family = reason ? (LOOKUP.get(reason.toLowerCase()) ?? null) : null;
  if (!family) return { family: null, Icon: CircleDashed, color: null };
  return {
    family,
    Icon: FAMILY_ICON[family],
    color: `hsl(${FAMILY_HUE[family]} var(--evt-s) var(--evt-l))`,
  };
}
