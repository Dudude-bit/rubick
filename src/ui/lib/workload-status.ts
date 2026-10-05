import type { Rollout } from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { Tone } from "@/lib/tone";
import { statusRole } from "@/lib/status-role";

/**
 * The one word a workload's rollout comes to, on every screen that draws it.
 *
 * Read from the backend's verdict, which reads the Available and Progressing
 * conditions before the counts: replica counts alone called a Deployment past
 * its progress deadline "Ready" while its old pods still served, and one with
 * no pod up at all "Progressing". The overview prints the same words, held
 * equal by `src/contracts/rollout-codes.json`.
 *
 * The text is the colour: `statusRole` looks these words up, so they are codes
 * and stay untranslated.
 */
export type WorkloadStatus =
  | "Ready"
  | "Progressing"
  | "Idle"
  | "Stalled"
  | "Unavailable"
  | "Paused"
  | "Waiting"
  | "Degraded";

export const ROLLOUT_CODES: Record<Rollout["state"], WorkloadStatus> = {
  idle: "Idle",
  stalled: "Stalled",
  unavailable: "Unavailable",
  paused: "Paused",
  unobserved: "Waiting",
  rollingOut: "Progressing",
  short: "Degraded",
  ready: "Ready",
};

export function workloadStatus(rollout: Rollout): WorkloadStatus {
  return ROLLOUT_CODES[rollout.state];
}

/** The states the overview lists as needing attention; the shared file holds the two equal. */
export const NEEDS_ATTENTION: ReadonlySet<Rollout["state"]> = new Set([
  "stalled",
  "unavailable",
  "short",
]);

/** What the verdict says beyond its word, or nothing when the word is the whole story. */
export interface RolloutLine {
  tone: Exclude<Tone, "ok" | "unknown">;
  text: string;
  /** The controller's own message, quoted as written. */
  said: string | null;
}

export function rolloutLine(rollout: Rollout, t: T): RolloutLine | null {
  switch (rollout.state) {
    case "idle":
    case "ready":
      return null;
    case "stalled":
      return {
        tone: "err",
        text:
          rollout.serving > 0
            ? t("readings", "rolloutStalledServing", { n: rollout.serving })
            : t("readings", "rolloutStalled"),
        said: rollout.message,
      };
    case "unavailable":
      return {
        tone: "err",
        text: rollout.reason
          ? t("readings", "rolloutUnavailableReason", {
              reason: rollout.reason,
            })
          : t("readings", "rolloutUnavailable"),
        said: rollout.message,
      };
    case "paused":
      return { tone: "warn", text: t("readings", "rolloutPaused"), said: null };
    case "unobserved":
      return {
        tone: "info",
        text: t("readings", "rolloutUnobserved"),
        said: null,
      };
    case "rollingOut":
      return {
        tone: "info",
        text: t("readings", "rolloutMoving", {
          updated: rollout.updated,
          n: rollout.desired,
        }),
        said: null,
      };
    case "short":
      return {
        tone: "warn",
        text: t("readings", "rolloutShort", {
          available: rollout.available,
          n: rollout.desired,
        }),
        said: null,
      };
  }
}

/** "Stalled · 2/2 ready" for a shared report: the badge's word and colour beside the count. */
export function rolloutStatusOf(
  ready: number,
  desired: number,
  rollout: Rollout,
  t: T
) {
  const count = t("count", "slashReady", { n: ready, total: desired });
  const code = workloadStatus(rollout);
  return {
    text: rolloutLine(rollout, t) ? `${code} · ${count}` : count,
    role: statusRole(code),
  };
}
