import type { T } from "@/i18n/useT";

/**
 * The words a status carries that this app composed, not the cluster.
 *
 * `Suspended` is how a Job or CronJob reads `spec.suspend: true`, and
 * `Waiting` is a rollout whose generation the controller has not observed:
 * neither is a value any object's status holds, so they are the reader's
 * language to word. Every other status stays as the cluster wrote it. The
 * code is still what `statusRole` looks up; this is only the label.
 */
export function ownStatusWord(code: string, t: T): string | undefined {
  switch (code) {
    case "Suspended":
      return t("statusWords", "suspended");
    case "Waiting":
      return t("statusWords", "waiting");
    default:
      return undefined;
  }
}

/** A CronJob's `Active` is ours as well: it is the absence of `spec.suspend`. */
export function cronStatusWord(suspend: boolean, t: T): string {
  return t("statusWords", suspend ? "suspended" : "active");
}
