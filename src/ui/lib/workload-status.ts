import type { PodRow, PodStart, Rollout } from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { Tone } from "@/lib/tone";
import { statusRole } from "@/lib/status-role";
import { ownStatusWord } from "@/lib/status-words";

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
  comingUp: "Progressing",
  scalingDown: "Progressing",
  short: "Degraded",
  ready: "Ready",
};

export function workloadStatus(rollout: Rollout): WorkloadStatus {
  return ROLLOUT_CODES[rollout.state];
}

/** The verdict as the reader's language words it; `workloadStatus` stays the code `statusRole` reads. */
export function workloadWord(rollout: Rollout, t: T): string {
  const code = workloadStatus(rollout);
  return ownStatusWord(code, t) ?? code;
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
    case "comingUp":
      return {
        tone: "info",
        text: t("readings", "rolloutComingUp", {
          available: rollout.available,
          n: rollout.desired,
        }),
        said: null,
      };
    case "scalingDown":
      return {
        tone: "info",
        text: t("readings", "rolloutScalingDown", {
          current: rollout.current,
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

/** The counts of a state whose gap the workload's own pods can explain as coming up. */
function podsCanExplain(
  rollout: Rollout
): { available: number; desired: number } | null {
  switch (rollout.state) {
    case "short":
    case "unobserved":
      return rollout.available < rollout.desired ? rollout : null;
    case "unavailable":
      return rollout.available === 0 && rollout.desired > 0 ? rollout : null;
    default:
      return null;
  }
}

/**
 * A workload short of available pods, with none available yet, or whose
 * newest spec its controller has not read, is coming up while some of its
 * pods are still starting and none shows a fault; otherwise it stays as it
 * read. `with_starts` in `rollout.rs` answers the page, the peek and Needs
 * attention, and `src/contracts/set-rollout-conformance.json` holds the two
 * equal.
 */
export function withStarts(
  rollout: Rollout,
  starts: readonly PodStart[],
  now: number
): Rollout {
  const counts = podsCanExplain(rollout);
  if (!counts) return rollout;
  let coming = false;
  for (const start of starts) {
    if (start.state === "settled") continue;
    if (start.state === "failing" || Date.parse(start.until) <= now)
      return rollout;
    coming = true;
  }
  return coming
    ? {
        state: "comingUp",
        available: counts.available,
        desired: counts.desired,
      }
    : rollout;
}

/** The pods of each workload, and every instant one of their starts runs out. */
export interface WorkloadStarts {
  byWorkload: ReadonlyMap<string, PodStart[]>;
  deadlines: readonly number[];
}

const workloadKey = (kind: string, namespace: string, name: string) =>
  `${kind}\0${namespace}\0${name}`;

/** Each pod under the workload Rust read off its owner, a Deployment's through its ReplicaSet. */
export function startsOf(
  pods: readonly Pick<PodRow, "namespace" | "start" | "workload">[]
): WorkloadStarts {
  const byWorkload = new Map<string, PodStart[]>();
  const deadlines: number[] = [];
  for (const pod of pods) {
    if (!pod.workload) continue;
    const key = workloadKey(
      pod.workload.kind,
      pod.namespace,
      pod.workload.name
    );
    const starts = byWorkload.get(key);
    if (starts) starts.push(pod.start);
    else byWorkload.set(key, [pod.start]);
    if (pod.start.state === "starting")
      deadlines.push(Date.parse(pod.start.until));
  }
  return { byWorkload, deadlines };
}

/**
 * The latest start that has run out by `now`, which answers {@link withStarts}
 * exactly as `now` does and changes only when one more runs out: a clock read
 * through it wakes the list once per expiry, not once per tick.
 */
export const lastRunOut = (deadlines: readonly number[], now: number) =>
  deadlines.reduce(
    (latest, at) => (at <= now && at > latest ? at : latest),
    Number.NEGATIVE_INFINITY
  );

/** Each row's verdict with its own pods asked; a row it does not change keeps its identity. */
export function rowsWithStarts<
  Row extends { name: string; namespace: string; rollout: Rollout },
>(
  kind: string,
  rows: readonly Row[],
  starts: WorkloadStarts,
  now: number
): Row[] {
  return rows.map((row) => {
    const rollout = withStarts(
      row.rollout,
      starts.byWorkload.get(workloadKey(kind, row.namespace, row.name)) ?? [],
      now
    );
    return rollout === row.rollout ? row : { ...row, rollout };
  });
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
    text: rolloutLine(rollout, t)
      ? `${ownStatusWord(code, t) ?? code} · ${count}`
      : count,
    role: statusRole(code),
  };
}
