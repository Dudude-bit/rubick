import type { CompositionSegment } from "@/components/object/detail-blocks";
import type { PodStart, PodStatusInfo } from "@/generated/types";
import { useLastPassed } from "@/hooks/useNow";
import type { T } from "@/i18n/useT";
import { loopState } from "@/lib/crash-loop";

type Counted = {
  start: PodStart;
  status: Pick<
    PodStatusInfo,
    "display" | "ready" | "loopingUntil" | "exitUnreported"
  >;
};

/** What a bar counts, which Russian agrees its words with: a replica, or a DaemonSet's node. */
export type ReplicaUnit = "replica" | "node";

const NOT_READY = {
  replica: "notReadySegment",
  node: "nodesNotReadySegment",
} as const satisfies Record<ReplicaUnit, string>;

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
 * leave all of it to the controller. A replica no pod read accounts for is
 * starting while the header's verdict is still `waiting` on its pods, as
 * the header says it is.
 */
export function replicaSplit(
  made: number,
  counted: number,
  pods: readonly Counted[] | null,
  now: number,
  t: T,
  waiting = false,
  unit: ReplicaUnit = "replica"
): ReplicaSplit {
  let ready = Math.min(counted, made);
  let starting = 0;
  let failing = 0;
  let unaccounted = made - ready;
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
    unaccounted = Math.max(0, made - pods.length);
  }
  if (waiting)
    starting += Math.min(unaccounted, made - ready - starting - failing);
  const notReady = made - ready - starting - failing;
  return {
    ready,
    gap: [
      {
        label: t("count", "startingSegment", { n: starting }),
        count: starting,
        tone: "pending",
      },
      {
        label: t("count", "failingSegment", { n: failing }),
        count: failing,
        tone: "err",
      },
      {
        label: t("count", NOT_READY[unit], { n: notReady }),
        count: notReady,
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
  return useLastPassed(
    (pods ?? []).flatMap(({ start, status }) => [
      ...(start.state === "starting" ? [Date.parse(start.until)] : []),
      ...(status.loopingUntil ? [Date.parse(status.loopingUntil)] : []),
    ])
  );
}
