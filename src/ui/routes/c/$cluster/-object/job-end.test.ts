import { describe, expect, it } from "vite-plus/test";

import type { T } from "@/i18n/useT";
import { formatDate, formatDuration } from "@/lib/utils";
import { jobEndRow, jobRanFor, type JobTimes } from "./job-end";

const t = ((section: string, key: string) => `${section}.${key}`) as T;

const START = "2026-10-05T17:30:00Z";
const LATER = Date.parse("2026-10-05T18:30:00Z");

const job = (over: Partial<JobTimes>): JobTimes => ({
  status: "Running",
  startTime: START,
  completionTime: null,
  conditions: [],
  ...over,
});

const failedAt = (lastTransitionTime: string | null) =>
  job({
    status: "Failed",
    conditions: [
      {
        type: "Failed",
        status: "True",
        reason: "BackoffLimitExceeded",
        message: null,
        lastTransitionTime,
      },
    ],
  });

describe("when a Job ended", () => {
  /** A failed Job has no completionTime; reading only that field said "still running" under a Failed header. */
  it("dates a failed Job by its Failed condition, in red", () => {
    expect(jobEndRow(failedAt("2026-10-05T17:30:21Z"), t)).toEqual({
      label: "action.failedAt",
      value: formatDate("2026-10-05T17:30:21Z"),
      tone: "err",
    });
  });

  /** Ran for counted to now, so a Job that failed in 21 s kept growing for hours. */
  it("stops the clock where the Job failed, not at now", () => {
    expect(jobRanFor(failedAt("2026-10-05T17:30:21Z"), LATER)).toBe(
      formatDuration(21)
    );
  });

  /** A Failed condition with no time must not read as running, nor be timed to now. */
  it("says the end was not recorded rather than inventing one", () => {
    const job = failedAt(null);
    expect(jobEndRow(job, t)).toMatchObject({
      label: "action.failedAt",
      value: "action.endNotRecorded",
    });
    expect(jobRanFor(job, LATER)).toBeNull();
  });

  /** The success path keeps the field the controller sets for it. */
  it("dates a complete Job by its completionTime", () => {
    const done = job({
      status: "Complete",
      completionTime: "2026-10-05T17:32:00Z",
    });
    expect(jobEndRow(done, t)).toMatchObject({
      label: "action.finished",
      value: formatDate("2026-10-05T17:32:00Z"),
    });
    expect(jobRanFor(done, LATER)).toBe(formatDuration(120));
  });

  /** Only a Job that is actually running is "still running". */
  it("says still running only while it runs, and nothing before it starts", () => {
    expect(jobEndRow(job({}), t)).toMatchObject({
      value: "action.stillRunning",
    });
    expect(jobRanFor(job({}), LATER)).toBe(formatDuration(3600));
    expect(jobEndRow(job({ status: "Pending", startTime: null }), t)).toBe(
      null
    );
    expect(jobEndRow(job({ status: "Suspended" }), t)).toBe(null);
  });
});
