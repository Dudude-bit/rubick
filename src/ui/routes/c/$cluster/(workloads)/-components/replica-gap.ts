import type { CompositionSegment } from "@/components/object/detail-blocks";
import type { PodStart } from "@/generated/types";
import { useNowReading } from "@/hooks/useNow";
import type { T } from "@/i18n/useT";
import { lastRunOut } from "@/lib/workload-status";

type Started = { start: PodStart };

/**
 * The part of a Replicas bar that is not ready, split by what the
 * workload's own pods say, as its verdict reads them: still inside the wait
 * their start allows, in blue; failing, crash-looping or stuck, in red; and
 * the rest by the controller's count alone, in amber. Pods that were not
 * read leave all of it to the controller.
 */
export function replicaGap(
  gap: number,
  pods: readonly Started[] | null,
  now: number,
  t: T
): CompositionSegment[] {
  let starting = 0;
  let failing = 0;
  for (const { start } of pods ?? []) {
    if (start.state === "failing") failing += 1;
    else if (start.state === "starting" && Date.parse(start.until) > now)
      starting += 1;
  }
  failing = Math.min(failing, gap);
  starting = Math.min(starting, gap - failing);
  return [
    {
      label: t("count", "startingSegment"),
      count: starting,
      tone: "pending",
    },
    { label: t("count", "failingSegment"), count: failing, tone: "err" },
    {
      label: t("count", "notReadyWord"),
      count: gap - starting - failing,
      tone: "warn",
    },
  ];
}

/** The clock {@link replicaGap} reads, moving only when one of these pods' waits runs out. */
export function useStartsClock(pods: readonly Started[] | null): number {
  return useNowReading(10_000, (now) =>
    lastRunOut(
      (pods ?? []).flatMap(({ start }) =>
        start.state === "starting" ? [Date.parse(start.until)] : []
      ),
      now
    )
  );
}
