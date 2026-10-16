import shared from "../../contracts/crash-loop.json";
import type { ContainerInfo } from "@/generated/types";
import { lastTermination } from "@/lib/pod-status";

/** `CRASH_LOOP_WINDOW_SECONDS` in `pod_display.rs`, from the file both read. */
export const CRASH_LOOP_WINDOW_MS = shared.windowSeconds * 1000;

/**
 * Whether a pod kubectl calls `Running` is up between the crashes of a loop:
 * still before the moment `looping_until` in `pod_display.rs` ships, which
 * `crash_looping` compares with its own clock the same way.
 */
export function loopingNow(
  status: { loopingUntil?: string | null },
  now: number = Date.now()
): boolean {
  if (!status.loopingUntil) return false;
  const until = Date.parse(status.loopingUntil);
  return !Number.isNaN(until) && now < until;
}

/** The words kubectl prints while the kubelet backs off an app container, or the init container a pod is held on. */
const BACKING_OFF: ReadonlySet<string> = new Set([
  "CrashLoopBackOff",
  "Init:CrashLoopBackOff",
]);

/**
 * Where a pod stands in a crash loop, by what its row ships: crashing, at
 * any instant of the back-off, its init container's included; restarted
 * with no exit the kubelet still reports, which is not health; or clear.
 * `crash_looping` and `exit_unreported` in `pod_display.rs` answer the
 * cases in `src/contracts/crash-loop.json` the same way.
 */
export type LoopState = "looping" | "unreported" | "clear";

export function loopState(
  status: {
    display: string;
    loopingUntil?: string | null;
    exitUnreported?: boolean;
  },
  now: number = Date.now()
): LoopState {
  if (BACKING_OFF.has(status.display) || loopingNow(status, now))
    return "looping";
  return status.exitUnreported ? "unreported" : "clear";
}

/** Until the moment `restarting_until` in `pod_display.rs` ships: exits after short runs, inside the hour. */
export function restartingNow(
  status: { restartingUntil?: string | null },
  now: number = Date.now()
): boolean {
  if (!status.restartingUntil) return false;
  const until = Date.parse(status.restartingUntil);
  return !Number.isNaN(until) && now < until;
}

/**
 * Whether a pod's restart count is news, drawn amber, rather than history:
 * looping, restarted with no exit reported, or exiting after short runs
 * inside the hour. Restarts that each ended a long run, a cluster restart
 * above all, are history, as the Overview reads them.
 */
export function restartsAreNews(
  pod: {
    restartCount: number;
    status: {
      display: string;
      loopingUntil?: string | null;
      exitUnreported?: boolean;
      restartingUntil?: string | null;
    };
  },
  now: number = Date.now()
): boolean {
  return (
    pod.restartCount > 0 &&
    (loopState(pod.status, now) !== "clear" || restartingNow(pod.status, now))
  );
}

/** The same for one container: one that is up again after exits it ended in long runs is history too. */
export function containerRestartsAreNews(
  container: ContainerInfo,
  now: number = Date.now()
): boolean {
  if (container.restartCount === 0) return false;
  if (container.state.type !== "running" || !lastTermination(container))
    return true;
  return loopingNow(container, now) || restartingNow(container, now);
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
  until: string;
  restarts: number;
}

type LoopPod = {
  uid: string;
  restartCount: number;
  status: {
    display: string;
    loopingUntil?: string | null;
    exitUnreported?: boolean;
  };
};

/**
 * What to remember after this read: the moment its loop lapses, the window
 * from when the kubelet was first seen backing off since the last restart,
 * or what was remembered before, kept as the same object when nothing new
 * was seen.
 */
export function seenLoop(
  pod: LoopPod,
  previous: SeenLoop | null,
  now: number = Date.now()
): SeenLoop | null {
  const same = previous?.uid === pod.uid;
  const until = pod.status.loopingUntil;
  if (until)
    return same &&
      previous.until === until &&
      previous.restarts === pod.restartCount
      ? previous
      : { uid: pod.uid, until, restarts: pod.restartCount };
  if (
    pod.status.display === "CrashLoopBackOff" &&
    !(same && previous.restarts >= pod.restartCount)
  )
    return {
      uid: pod.uid,
      until: new Date(now + CRASH_LOOP_WINDOW_MS).toISOString(),
      restarts: pod.restartCount,
    };
  return previous;
}

const RESTARTING_FAILED = /restarting failed container/i;

/**
 * A pod whose last exit the kubelet stopped reporting, looping until the
 * latest sign its loop goes on lapses: a loop this screen saw on it with no
 * fewer restarts since, or the window from the kubelet backing off a failed
 * container of it. Any other pod, and one with no such sign, comes back as
 * it was.
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
  if (!pod.status.exitUnreported || pod.status.loopingUntil) return pod;
  const signs = [
    seen?.uid === pod.uid && pod.restartCount >= seen.restarts
      ? Date.parse(seen.until)
      : NaN,
    ...events
      .filter(
        (event) =>
          event.reason === "BackOff" &&
          RESTARTING_FAILED.test(event.message ?? "")
      )
      .map(
        (event) => Date.parse(event.lastTimestamp ?? "") + CRASH_LOOP_WINDOW_MS
      ),
  ].filter((until) => !Number.isNaN(until));
  if (signs.length === 0) return pod;
  const until = new Date(Math.max(...signs)).toISOString();
  return { ...pod, status: { ...pod.status, loopingUntil: until } };
}
