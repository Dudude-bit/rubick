import type { T } from "@/i18n/useT";
import type { StatusRole } from "@/lib/status-role";
import type { Tone } from "@/lib/tone";

export type CronOutcome =
  | "never"
  | "running"
  | "refused"
  | "succeeded"
  | "notSucceeded";

/**
 * How a CronJob's newest run went, by its own status: `lastSuccessfulTime`
 * moves only when a run succeeds, so one older than the last schedule with
 * nothing active is a run that ended without succeeding. Live, reports had
 * failed every run for six days under a list that never said so. A run in
 * flight whose pods the API server refuses has not started anything.
 */
export function cronOutcome(
  cron: {
    active: number;
    lastSchedule: string | null;
    lastSuccessfulTime: string | null;
  },
  refused = false
): CronOutcome {
  if (cron.active > 0) return refused ? "refused" : "running";
  if (!cron.lastSchedule)
    return cron.lastSuccessfulTime ? "succeeded" : "never";
  return Date.parse(cron.lastSuccessfulTime ?? "") >=
    Date.parse(cron.lastSchedule)
    ? "succeeded"
    : "notSucceeded";
}

/**
 * The Job its last schedule started, by the name the controller gives it:
 * the CronJob's name and the scheduled minute since the epoch.
 */
export function scheduledRun(cron: {
  name: string;
  lastSchedule: string | null;
}): string | null {
  const at = Date.parse(cron.lastSchedule ?? "");
  return Number.isFinite(at) ? `${cron.name}-${Math.floor(at / 60_000)}` : null;
}

const OUTCOME: Record<
  CronOutcome,
  {
    key:
      | "never"
      | "cronRunning"
      | "cronRefused"
      | "cronSucceeded"
      | "cronNotSucceeded";
    tone: Extract<Tone, "info" | "err"> | null;
  }
> = {
  never: { key: "never", tone: null },
  running: { key: "cronRunning", tone: "info" },
  refused: { key: "cronRefused", tone: "err" },
  succeeded: { key: "cronSucceeded", tone: null },
  notSucceeded: { key: "cronNotSucceeded", tone: "err" },
};

/** The outcome in the reader's words, and the tone only where it is news. */
export const outcomeWords = (outcome: CronOutcome, t: T) => ({
  word: t("action", OUTCOME[outcome].key),
  tone: OUTCOME[outcome].tone,
});

/** The outcome's tone as a Share report colours a cell. */
export const TONE_ROLE: Record<"info" | "err", StatusRole> = {
  info: "pending",
  err: "err",
};
