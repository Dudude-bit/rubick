// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { renderHook } from "@testing-library/react";

import type { T } from "@/i18n/useT";
import type { JobDetailInfo, PodInfo } from "@/generated/types";
import { formatDuration } from "@/lib/utils";
import { jobStatsOf, jobStatusOf, useJobShare } from "./useJobShare";

const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${section}.${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : `${section}.${key}`) as unknown as T;

const job = {
  name: "backfill",
  namespace: "batch",
  completions: 5,
  parallelism: 2,
  backoffLimit: 3,
  succeeded: 3,
  failed: 1,
  active: 1,
  status: "Running",
  startTime: "2026-09-25T10:00:00Z",
  completionTime: null,
  containers: [
    {
      name: "worker",
      image: "registry.example/batch/backfill:9.0.0",
      phase: "app",
    },
  ],
  initContainers: [],
} as unknown as JobDetailInfo;

describe("what the Job page adds to Share", () => {
  /** Succeeded over completions is the number the reader came to check. */
  it("carries succeeded over completions as a stat", () => {
    const stats = jobStatsOf(job, "2026-09-25T12:00:00Z", t);
    expect(stats).toContainEqual(
      expect.objectContaining({ label: "columns.completions", value: "3/5" })
    );
  });

  /** Failed pods are a warning even mid-run, since a Job with retries left can still be in trouble. */
  it("flags failed pods with a warn role when any have failed", () => {
    const stats = jobStatsOf(job, "2026-09-25T12:00:00Z", t);
    const failedStat = stats.find((stat) => stat.label === "share.wlFailed");
    expect(failedStat).toMatchObject({ value: "1", role: "warn" });
  });

  /** A failed Job has no completionTime; the report timed it to the capture instead. */
  it("times a failed Job to its Failed condition, not to the capture", () => {
    const failed = {
      ...job,
      status: "Failed",
      conditions: [
        {
          type: "Failed",
          status: "True",
          reason: "BackoffLimitExceeded",
          message: null,
          lastTransitionTime: "2026-09-25T10:00:21Z",
        },
      ],
    } as JobDetailInfo;
    const stats = jobStatsOf(failed, "2026-09-25T12:00:00Z", t);
    expect(stats.find((stat) => stat.label === "action.ranFor")?.value).toBe(
      formatDuration(21)
    );
  });

  /** The raw status word is what the badge shows; the file must not translate it into something new. */
  it("takes its status text straight from the cluster's own word", () => {
    const status = jobStatusOf(job);
    expect(status.text).toBe("Running");
    expect(status.role).toBe("ok");
  });

  /** The wiring itself: dropping the pods table from the hook's return must fail this. */
  it("puts the completions stat and a pods table in what the hook hands to Share", () => {
    const pods = [
      {
        name: "backfill-abc",
        namespace: "batch",
        status: { display: "Running" },
        restartCount: 0,
        containers: [{ ready: true, state: { type: "running" } }],
        initContainers: [],
      },
    ] as unknown as PodInfo[];
    const { result } = renderHook(() => useJobShare(job, pods, null));
    const contribution = result.current({
      silent: new Map(),
      capturedAt: "2026-09-25T12:00:00Z",
    });
    expect(contribution.stats).toContainEqual(
      expect.objectContaining({ value: "3/5" })
    );
    const podsSection = contribution.sections?.find((s) => s.id === "pods");
    expect(podsSection?.count).toBe(1);
  });
});
