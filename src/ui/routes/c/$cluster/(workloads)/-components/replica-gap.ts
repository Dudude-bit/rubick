import type { CompositionSegment } from "@/components/object/detail-blocks";
import type { PodStart, PodStatusInfo } from "@/generated/types";
import { useNowReading } from "@/hooks/useNow";
import type { T } from "@/i18n/useT";
import { loopState } from "@/lib/crash-loop";
import { lastRunOut } from "@/lib/workload-status";

type Counted = {
  start: PodStart;
  status: Pick<
    PodStatusInfo,
    "display" | "ready" | "loopingUntil" | "exitUnreported"
  >;
};

export interface ReplicaSplit {
  ready: number;
  /** Starting in blue, failing in red, the rest not ready in amber. */
  gap: CompositionSegment[];
}

/**
 * The part of a Replicas bar its controller says was made, split as the
 * page's own rows read the same pods: ready; failing, crash-looping or
 * stuck, in red, a pod up between the crashes of a loop included, as its
 * row paints it; still inside the wait its start allows, in blue; and the
 * rest not ready, in amber. The controller's counts lag the pods, so where
 * the page holds them they only bound the split. Pods that were not read
 * leave all of it to the controller.
 */
export function replicaSplit(
  made: number,
  counted: number,
  pods: readonly Counted[] | null,
  now: number,
  t: T
): ReplicaSplit {
  let ready = Math.min(counted, made);
  let starting = 0;
  let failing = 0;
  if (pods !== null) {
    ready = 0;
    for (const { start, status } of pods) {
      if (start.state === "failing" || loopState(status, now) === "looping")
        failing += 1;
      else if (start.state === "starting" && Date.parse(start.until) > now)
        starting += 1;
      else if (status.ready && status.display !== "Terminating") ready += 1;
    }
    ready = Math.min(ready, made);
    failing = Math.min(failing, made - ready);
    starting = Math.min(starting, made - ready - failing);
  }
  return {
    ready,
    gap: [
      {
        label: t("count", "startingSegment"),
        count: starting,
        tone: "pending",
      },
      { label: t("count", "failingSegment"), count: failing, tone: "err" },
      {
        label: t("count", "notReadyWord"),
        count: made - ready - starting - failing,
        tone: "warn",
      },
    ],
  };
}

/**
 * The clock {@link replicaSplit} reads, moving only when one of these pods'
 * waits, or the window a crash loop is counted in, runs out.
 */
export function useStartsClock(pods: readonly Counted[] | null): number {
  return useNowReading(10_000, (now) =>
    lastRunOut(
      (pods ?? []).flatMap(({ start, status }) => [
        ...(start.state === "starting" ? [Date.parse(start.until)] : []),
        ...(status.loopingUntil ? [Date.parse(status.loopingUntil)] : []),
      ]),
      now
    )
  );
}
