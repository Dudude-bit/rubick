import shared from "../../contracts/crash-loop.json";
import type { ContainerInfo } from "@/generated/types";
import { lastTermination } from "@/lib/pod-status";

/** `CRASH_LOOP_WINDOW_SECONDS` in `pod_display.rs`, from the file both read. */
export const CRASH_LOOP_WINDOW_MS = shared.windowSeconds * 1000;

/**
 * Whether a pod kubectl calls `Running` is up between the crashes of a loop,
 * measured from the exit the backend ships as `crash_looping` measures it.
 */
export function loopingNow(
  status: { loopingExitAt?: string | null },
  now: number = Date.now()
): boolean {
  if (!status.loopingExitAt) return false;
  const at = Date.parse(status.loopingExitAt);
  return !Number.isNaN(at) && now - at < CRASH_LOOP_WINDOW_MS;
}

/**
 * Where a pod stands in a crash loop, by what its row ships: crashing, at
 * any instant of the back-off; restarted with no exit the kubelet still
 * reports, which is not health; or clear. `crash_looping` and
 * `exit_unreported` in `pod_display.rs` answer the cases in
 * `src/contracts/crash-loop.json` the same way.
 */
export type LoopState = "looping" | "unreported" | "clear";

export function loopState(
  status: {
    display: string;
    loopingExitAt?: string | null;
    exitUnreported?: boolean;
  },
  now: number = Date.now()
): LoopState {
  if (status.display === "CrashLoopBackOff" || loopingNow(status, now))
    return "looping";
  return status.exitUnreported ? "unreported" : "clear";
}

/**
 * The container whose exit that was: restarted twice or more, latest exit
 * first, or the one restarted most where the kubelet reports no exit.
 */
export function loopingContainer(
  containers: readonly ContainerInfo[]
): ContainerInfo | null {
  const finished = (c: ContainerInfo) =>
    Date.parse(lastTermination(c)?.finishedAt ?? "") || 0;
  const restarted = containers.filter((c) => c.restartCount >= 2);
  return (
    restarted
      .filter((c) => lastTermination(c))
      .sort((a, b) => finished(b) - finished(a))[0] ??
    restarted.sort((a, b) => b.restartCount - a.restartCount)[0] ??
    null
  );
}

/** A loop a screen saw on one pod, kept for a read that comes back without its exit. */
export interface SeenLoop {
  uid: string;
  at: string;
  restarts: number;
}

type LoopPod = {
  uid: string;
  restartCount: number;
  status: {
    display: string;
    loopingExitAt?: string | null;
    exitUnreported?: boolean;
  };
};

/**
 * What to remember after this read: its exit, the moment the kubelet was
 * first seen backing off since the last restart, or what was remembered
 * before, kept as the same object when nothing new was seen.
 */
export function seenLoop(
  pod: LoopPod,
  previous: SeenLoop | null,
  now: number = Date.now()
): SeenLoop | null {
  const same = previous?.uid === pod.uid;
  const exit = pod.status.loopingExitAt;
  if (exit)
    return same &&
      previous.at === exit &&
      previous.restarts === pod.restartCount
      ? previous
      : { uid: pod.uid, at: exit, restarts: pod.restartCount };
  if (
    pod.status.display === "CrashLoopBackOff" &&
    !(same && previous.restarts >= pod.restartCount)
  )
    return {
      uid: pod.uid,
      at: new Date(now).toISOString(),
      restarts: pod.restartCount,
    };
  return previous;
}

const RESTARTING_FAILED = /restarting failed container/i;

/**
 * A pod whose last exit the kubelet stopped reporting, measured from the
 * latest sign its loop goes on: a loop this screen saw on it with no fewer
 * restarts since, or the kubelet backing off a failed container of it. Any
 * other pod, and one with no such sign, comes back as it was.
 */
export function withKnownLoop<P extends LoopPod>(
  pod: P,
  seen: SeenLoop | null,
  events: readonly {
    reason: string | null;
    message: string | null;
    lastTimestamp: string | null;
  }[]
): P {
  if (!pod.status.exitUnreported || pod.status.loopingExitAt) return pod;
  const signs = [
    seen?.uid === pod.uid && pod.restartCount >= seen.restarts ? seen.at : null,
    ...events
      .filter(
        (event) =>
          event.reason === "BackOff" &&
          RESTARTING_FAILED.test(event.message ?? "")
      )
      .map((event) => event.lastTimestamp),
  ].filter((at): at is string => !!at && !Number.isNaN(Date.parse(at)));
  if (signs.length === 0) return pod;
  const at = signs.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
  return { ...pod, status: { ...pod.status, loopingExitAt: at } };
}
