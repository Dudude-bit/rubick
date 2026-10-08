import type { T } from "@/i18n/useT";

/**
 * The words a status carries that this app composed, not the cluster.
 *
 * `Suspended` is how a Job or CronJob reads `spec.suspend: true`, `Waiting`
 * a rollout whose generation the controller has not observed, and `Idle`,
 * `Stalled`, `Degraded` and `Retrying` the verdicts the app reaches from the
 * conditions and counts: none is a value any object's status holds, so they
 * are the reader's language to word. Every other status stays as the cluster
 * wrote it. The code is still what `statusRole` looks up; this is only the
 * label.
 */
export function ownStatusWord(code: string, t: T): string | undefined {
  switch (code) {
    case "Suspended":
      return t("statusWords", "suspended");
    case "Waiting":
      return t("statusWords", "waiting");
    case "Idle":
      return t("statusWords", "idle");
    case "Stalled":
      return t("statusWords", "stalled");
    case "Degraded":
      return t("statusWords", "degraded");
    case "Retrying":
      return t("statusWords", "retrying");
    default:
      return undefined;
  }
}

/** The same words for a legend that counts, which agrees with the number: "2 застряли" where a badge says "Застрял". */
export function ownCountedWord(
  code: string,
  n: number,
  t: T
): string | undefined {
  switch (code) {
    case "Stalled":
      return t("statusWords", "stalledCounted", { n });
    case "Degraded":
      return t("statusWords", "degradedCounted", { n });
    case "Idle":
      return t("statusWords", "idleCounted", { n });
    case "Retrying":
      return t("statusWords", "retryingCounted", { n });
    case "Suspended":
      return t("statusWords", "suspendedCounted", { n });
    case "Waiting":
      return t("statusWords", "waitingCounted", { n });
    default:
      return undefined;
  }
}

/** A CronJob's `Active` is ours as well: it is the absence of `spec.suspend`. */
export function cronStatusWord(suspend: boolean, t: T): string {
  return t("statusWords", suspend ? "suspended" : "active");
}
