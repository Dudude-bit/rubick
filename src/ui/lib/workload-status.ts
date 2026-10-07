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

/**
 * A set short of available pods is coming up while some of its pods are
 * still starting and none shows a fault; otherwise it stays as it read.
 * `with_starts` in `rollout.rs` answers the page, the peek and Needs
 * attention, and `src/contracts/set-rollout-conformance.json` holds the two
 * equal.
 */
export function withStarts(
  rollout: Rollout,
  starts: readonly PodStart[],
  now: number
): Rollout {
  if (rollout.state !== "short") return rollout;
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
        available: rollout.available,
        desired: rollout.desired,
      }
    : rollout;
}

/** The pods of each StatefulSet and DaemonSet, and every instant one of their starts runs out. */
export interface SetStarts {
  bySet: ReadonlyMap<string, PodStart[]>;
  deadlines: readonly number[];
}

const setKey = (namespace: string, name: string) => `${namespace}\0${name}`;

/**
 * Both kinds name a pod `<set>-<suffix>` with no dash in the suffix, an
 * ordinal or five random characters, which keeps a Deployment's
 * `<name>-<hash>-<suffix>` pods off a set that shares its name.
 */
export function setStartsOf(
  pods: readonly Pick<PodRow, "name" | "namespace" | "start">[]
): SetStarts {
  const bySet = new Map<string, PodStart[]>();
  const deadlines: number[] = [];
  for (const pod of pods) {
    const dash = pod.name.lastIndexOf("-");
    if (dash <= 0) continue;
    const key = setKey(pod.namespace, pod.name.slice(0, dash));
    const starts = bySet.get(key);
    if (starts) starts.push(pod.start);
    else bySet.set(key, [pod.start]);
    if (pod.start.state === "starting")
      deadlines.push(Date.parse(pod.start.until));
  }
  return { bySet, deadlines };
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

/** Each set row's verdict with its own pods asked; a row it does not change keeps its identity. */
export function rowsWithStarts<
  Row extends { name: string; namespace: string; rollout: Rollout },
>(rows: readonly Row[], starts: SetStarts, now: number): Row[] {
  return rows.map((row) => {
    const rollout = withStarts(
      row.rollout,
      starts.bySet.get(setKey(row.namespace, row.name)) ?? [],
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
