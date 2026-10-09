import type { CompositionSegment } from "@/components/object/detail-blocks";
import type { Rollout } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { NEEDS_ATTENTION } from "@/lib/workload-status";
import { replicaSplit } from "../../-components/replica-gap";

/**
 * The Replicas bar. A pod the page has read exists whether or not the
 * controller has counted it yet, a pod made and not ready is read by its
 * own start, and a pod not made yet is the ordered queue, a fault only
 * where the verdict already is one.
 */
export function setReplicaSegments(
  counts: { desired: number; current: number; ready: number },
  pods: Parameters<typeof replicaSplit>[2],
  now: number,
  rollout: Rollout | undefined,
  t: T
): CompositionSegment[] {
  const created = Math.min(
    counts.desired,
    Math.max(counts.current, pods?.length ?? 0)
  );
  const missing = Math.max(0, counts.desired - created);
  const split = replicaSplit(created, counts.ready, pods, now, t);
  return [
    {
      label: t("count", "readySegment", { n: split.ready }),
      count: split.ready,
      tone: "ok",
    },
    ...split.gap,
    {
      label: t("count", "notCreatedSegment", { n: missing }),
      count: missing,
      tone: rollout && NEEDS_ATTENTION.has(rollout.state) ? "err" : "neutral",
    },
  ];
}
