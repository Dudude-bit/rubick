import { useNowReading } from "@/hooks/useNow";
import { insideWait, type PodBadgeInput } from "@/lib/share/pod-status";

/** Whether the pod is inside its wait, on the clock its badge reads, so the two turn together. */
export function usePodWaiting(
  pod: Pick<PodBadgeInput, "status" | "start"> | null | undefined
): boolean {
  return (
    useNowReading(10_000, (now) => (pod && insideWait(pod, now) ? 1 : 0)) === 1
  );
}
