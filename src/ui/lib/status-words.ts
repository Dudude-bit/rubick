import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import type { WorkloadStatus } from "@/lib/workload-status";

type Word = keyof typeof en.statusWords;

/**
 * A rollout's verdict, every one the app's own: a Deployment's,
 * StatefulSet's or DaemonSet's status holds none of these words. The cluster
 * writes the Available and Progressing conditions and their reasons, which
 * stay as written wherever they are shown. The code is still what
 * `statusRole` looks up; this is only the label, and its count's form.
 */
const ROLLOUT_WORDS: Record<WorkloadStatus, [Word, Word]> = {
  Ready: ["ready", "readyCounted"],
  Progressing: ["progressing", "progressingCounted"],
  Idle: ["idle", "idleCounted"],
  Stalled: ["stalled", "stalledCounted"],
  Unavailable: ["unavailable", "unavailableCounted"],
  Paused: ["paused", "pausedCounted"],
  Waiting: ["waiting", "waitingCounted"],
  Degraded: ["degraded", "degradedCounted"],
};

export const isRolloutCode = (code: string): code is WorkloadStatus =>
  Object.hasOwn(ROLLOUT_WORDS, code);

export function rolloutWord(code: WorkloadStatus, t: T): string {
  return t("statusWords", ROLLOUT_WORDS[code][0]);
}

/** For a legend that counts, agreeing with the number: "2 застряли" where a badge says "Застрял". */
export function rolloutCountedWord(
  code: WorkloadStatus,
  n: number,
  t: T
): string {
  return t("statusWords", ROLLOUT_WORDS[code][1], { n });
}

/**
 * Words this app composed, not the cluster: a Job's `Suspended` is how it
 * reads `spec.suspend: true` and `Retrying` a verdict from its counts, and a
 * pod's `CrashLooping` the loop read off its exits while the kubelet says
 * something else. Complete, Failed and `CrashLoopBackOff` are the cluster's
 * and stay as written.
 */
export function ownStatusWord(code: string, t: T): string | undefined {
  switch (code) {
    case "Suspended":
      return t("statusWords", "suspended");
    case "Retrying":
      return t("statusWords", "retrying");
    case "CrashLooping":
      return t("statusWords", "crashLooping");
    default:
      return undefined;
  }
}

/** The same words for a legend that counts. */
export function ownCountedWord(
  code: string,
  n: number,
  t: T
): string | undefined {
  switch (code) {
    case "Retrying":
      return t("statusWords", "retryingCounted", { n });
    case "Suspended":
      return t("statusWords", "suspendedCounted", { n });
    default:
      return undefined;
  }
}

/** A CronJob's `Active` is ours as well: it is the absence of `spec.suspend`. */
export function cronStatusWord(suspend: boolean, t: T): string {
  return t("statusWords", suspend ? "suspended" : "active");
}
