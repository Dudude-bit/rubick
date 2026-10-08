import type { CompositionSegment } from "@/components/object/detail-blocks";
import type { Rollout } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { NEEDS_ATTENTION } from "@/lib/workload-status";

/**
 * The Replicas bar. A pod the page has read exists whether or not the
 * controller has counted it yet, and a pod not made yet is the ordered
 * queue, a fault only where the verdict already is one.
 */
export function setReplicaSegments(
  counts: { desired: number; current: number; ready: number },
  made: number,
  rollout: Rollout | undefined,
  t: T
): CompositionSegment[] {
  const created = Math.min(counts.desired, Math.max(counts.current, made));
  const starting = Math.max(0, created - counts.ready);
  const missing = Math.max(0, counts.desired - created);
  return [
    {
      label: t("count", "readySegment", { n: counts.ready }),
      count: counts.ready,
      tone: "ok",
    },
    {
      label: t("count", "startingSegment", { n: starting }),
      count: starting,
      tone: "warn",
    },
    {
      label: t("count", "notCreatedSegment", { n: missing }),
      count: missing,
      tone: rollout && NEEDS_ATTENTION.has(rollout.state) ? "err" : "neutral",
    },
  ];
}
