// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import type { T } from "@/i18n/useT";
import type { CronJobDetailInfo, JobInfo } from "@/generated/types";
import {
  cronJobStatsOf,
  cronJobStatusOf,
  jobsSection,
  useCronJobShare,
} from "./useCronJobShare";

const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${section}.${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : `${section}.${key}`) as unknown as T;

const cronJob = {
  name: "nightly-backup",
  namespace: "ops",
  schedule: "0 2 * * *",
  suspend: false,
  active: 0,
  lastSchedule: "2026-09-25T02:00:00Z",
  lastSuccessfulTime: "2026-09-25T02:03:00Z",
  containers: [
    {
      name: "backup",
      image: "registry.example/ops/backup:3.1.0",
      phase: "app",
    },
  ],
  initContainers: [],
} as unknown as CronJobDetailInfo;

const jobs = [
  {
    name: "nightly-backup-29123456",
    namespace: "ops",
    completions: 1,
    succeeded: 1,
    failed: 0,
    active: 0,
    status: "Complete",
    createdAt: "2026-09-25T02:00:00Z",
  },
] as unknown as JobInfo[];

describe("what the CronJob page adds to Share", () => {
  /** A refused run list and a CronJob that never fired are different answers, and the file must not fold them into one. */
  it("carries the read failure rather than an empty run list", () => {
    const section = jobsSection(
      jobs,
      new Error("forbidden"),
      "2026-09-25T12:00:00Z",
      t
    );
    expect(section.unread).toBe("empty.couldNotReadCronJobRuns");
  });

  /** Each run's own outcome, not the CronJob's, so a run list with one failure is legible at a glance. */
  it("lists a run with its own status and completion count", () => {
    const section = jobsSection(jobs, null, "2026-09-25T12:00:00Z", t);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "nightly-backup-29123456" },
            { text: "Complete", role: "neutral" },
            { text: "1/1" },
            { text: "10h" },
          ],
        },
      ],
    });
  });

  /** Suspended is a fact the badge already shows; the file must not soften it into "active". */
  it("says suspended when the CronJob is suspended", () => {
    const status = cronJobStatusOf({ ...cronJob, suspend: true });
    expect(status).toEqual({ text: "Suspended", role: "warn" });
  });

  /** No success yet, distinct from never having run at all. */
  it("warns when it has fired but never succeeded", () => {
    const stats = cronJobStatsOf(
      { ...cronJob, lastSuccessfulTime: null },
      "2026-09-25T12:00:00Z",
      t
    );
    const lastSuccess = stats.find(
      (stat) => stat.label === "columns.lastSuccess"
    );
    expect(lastSuccess).toMatchObject({
      value: "action.noRunSucceededYet",
      role: "warn",
    });
  });

  /** The wiring itself: dropping the runs table from the hook's return must fail this. */
  it("puts the schedule stat and a runs table in what the hook hands to Share", () => {
    const { result } = renderHook(() => useCronJobShare(cronJob, jobs, null));
    const contribution = result.current();
    expect(contribution.stats).toContainEqual(
      expect.objectContaining({ label: "Schedule", value: "0 2 * * *" })
    );
    const runs = contribution.sections?.find((s) => s.id === "jobs");
    expect(runs?.count).toBe(1);
  });
});
