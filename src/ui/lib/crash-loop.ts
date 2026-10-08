import shared from "../../contracts/crash-loop.json";
import type { ContainerInfo } from "@/generated/types";

/** `CRASH_LOOP_WINDOW_SECONDS` in `pod_display.rs`, from the file both read. */
export const CRASH_LOOP_WINDOW_MS = shared.windowSeconds * 1000;

/**
 * Whether a pod kubectl calls `Running` is up between the crashes of a loop,
 * measured from the exit the backend ships as `crash_looping` measures it.
 */
export function loopingNow(
  status: { loopingExitAt?: string },
  now: number = Date.now()
): boolean {
  if (!status.loopingExitAt) return false;
  const at = Date.parse(status.loopingExitAt);
  return !Number.isNaN(at) && now - at < CRASH_LOOP_WINDOW_MS;
}

/** The container whose exit that was: restarted twice or more, latest exit first. */
export function loopingContainer(
  containers: readonly ContainerInfo[]
): ContainerInfo | null {
  const finished = (c: ContainerInfo) =>
    Date.parse(c.lastTerminated?.finishedAt ?? "") || 0;
  return (
    containers
      .filter((c) => c.restartCount >= 2 && c.lastTerminated)
      .sort((a, b) => finished(b) - finished(a))[0] ?? null
  );
}
