import type { CompositionSegment } from "@/components/object/detail-blocks";
import type { PodStart, Rollout } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { NEEDS_ATTENTION } from "@/lib/workload-status";
import { replicaGap } from "../../-components/replica-gap";

/**
 * The Replicas bar. A pod the page has read exists whether or not the
 * controller has counted it yet, a pod made and not ready is read by its
 * own start, and a pod not made yet is the ordered queue, a fault only
 * where the verdict already is one.
 */
export function setReplicaSegments(
  counts: { desired: number; current: number; ready: number },
  pods: readonly { start: PodStart }[] | null,
  now: number,
  rollout: Rollout | undefined,
  t: T
): CompositionSegment[] {
  const created = Math.min(
    counts.desired,
    Math.max(counts.current, pods?.length ?? 0)
  );
  const missing = Math.max(0, counts.desired - created);
  return [
    {
      label: t("count", "readySegment", { n: counts.ready }),
      count: counts.ready,
      tone: "ok",
    },
    ...replicaGap(Math.max(0, created - counts.ready), pods, now, t),
    {
      label: t("count", "notCreatedSegment", { n: missing }),
      count: missing,
      tone: rollout && NEEDS_ATTENTION.has(rollout.state) ? "err" : "neutral",
    },
  ];
}
