import { useLastPassed } from "@/hooks/useNow";
import {
  insideWait,
  podDeadlines,
  type PodBadgeInput,
} from "@/lib/share/pod-status";

/** Whether the pod is inside its wait, on the clock its badge reads, so the two turn together. */
export function usePodWaiting(
  pod: Pick<PodBadgeInput, "status" | "start"> | null | undefined
): boolean {
  const passed = useLastPassed(pod ? podDeadlines(pod) : []);
  return !!pod && insideWait(pod, passed);
}
