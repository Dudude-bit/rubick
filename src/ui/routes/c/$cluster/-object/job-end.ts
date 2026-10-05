import type { KeyValue } from "@/components/object/key-values";
import type { ConditionInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { formatDate, formatDuration } from "@/lib/utils";

export interface JobTimes {
  status: string;
  startTime: string | null;
  completionTime: string | null;
  conditions: ConditionInfo[];
}

/**
 * When the controller ended the Job: `undefined` while it has not, `null`
 * when it ended without saying when. A failed Job has no `completionTime`,
 * only its Failed condition's time.
 */
export function jobEndedAt(job: JobTimes): string | null | undefined {
  if (job.status !== "Complete" && job.status !== "Failed") return undefined;
  const condition = job.conditions.find(
    (c) => c.type === job.status && c.status === "True"
  );
  return (
    (job.status === "Complete" ? job.completionTime : null) ??
    condition?.lastTransitionTime ??
    null
  );
}

/** Start to end, or to `now` while it runs; `null` where either end is unknown. */
export function jobRanFor(job: JobTimes, now: number): string | null {
  const end = jobEndedAt(job);
  if (!job.startTime || end === null) return null;
  const from = Date.parse(job.startTime);
  const to = end === undefined ? now : Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return formatDuration((to - from) / 1000);
}

/** The row that says how and when it ended, or that it still runs. */
export function jobEndRow(job: JobTimes, t: T): KeyValue | null {
  const end = jobEndedAt(job);
  if (end === undefined) {
    return job.startTime && job.status !== "Suspended"
      ? { label: t("action", "finished"), value: t("action", "stillRunning") }
      : null;
  }
  const failed = job.status === "Failed";
  return {
    label: t("action", failed ? "failedAt" : "finished"),
    value: end ? formatDate(end) : t("action", "endNotRecorded"),
    tone: failed ? "err" : undefined,
  };
}
