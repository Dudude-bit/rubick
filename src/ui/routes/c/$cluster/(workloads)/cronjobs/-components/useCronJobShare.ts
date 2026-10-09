import { useCallback } from "react";

import type {
  ShareContribution,
  ShareFrame,
} from "@/components/share/contribution";
import { templateContainersSection } from "../../-components/containers-section";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportStat, ReportValue } from "@/lib/report";
import {
  ORDER,
  kindIcon,
  refOf,
  type PlacedSection,
  utcMoment,
} from "@/lib/report-parts";
import { statusRole } from "@/lib/status-role";
import { cronStatusWord, ownStatusWord } from "@/lib/status-words";
import { formatSince } from "@/lib/utils";
import type { CronJobDetailInfo, JobInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

export function cronJobStatusOf(cronJob: CronJobDetailInfo, t: T) {
  return {
    text: cronStatusWord(cronJob.suspend, t),
    role: statusRole(cronJob.suspend ? "Suspended" : "Active"),
  };
}

export function cronJobStatsOf(
  cronJob: CronJobDetailInfo,
  capturedAt: string,
  t: T
): ReportStat[] {
  const stats: ReportStat[] = [
    {
      label: t("columns", "schedule"),
      value: cronJob.schedule || t("empty", "noneLower"),
    },
    { label: t("columns", "active"), value: String(cronJob.active) },
    {
      label: t("columns", "lastRun"),
      value: cronJob.lastSchedule
        ? formatSince(Date.parse(cronJob.lastSchedule), Date.parse(capturedAt))
        : t("action", "never"),
    },
  ];
  stats.push(
    cronJob.lastSuccessfulTime
      ? {
          label: t("columns", "lastSuccess"),
          value: Number.isNaN(Date.parse(cronJob.lastSuccessfulTime))
            ? cronJob.lastSuccessfulTime
            : utcMoment(Date.parse(cronJob.lastSuccessfulTime)),
        }
      : {
          label: t("columns", "lastSuccess"),
          value: cronJob.lastSchedule
            ? t("action", "noRunSucceededYet")
            : t("action", "cronJobNeverFired"),
          role: cronJob.lastSchedule ? "warn" : undefined,
        }
  );
  return stats;
}

/** The runs the Jobs tab already read, newest first, with each one's own outcome. */
export function jobsSection(
  jobs: readonly JobInfo[],
  error: unknown,
  capturedAt: string,
  t: T
): PlacedSection {
  const unread = error ? t("empty", "couldNotReadCronJobRuns") : null;
  const rows = jobs.map((job) => {
    const cells: ReportValue[] = [
      {
        text: job.name,
        ref: refOf({ kind: "Job", name: job.name, namespace: job.namespace }),
      },
      {
        text: ownStatusWord(job.status, t) ?? (job.status || "Unknown"),
        role: statusRole(job.status || ""),
      },
      { text: `${job.succeeded}/${job.completions ?? 1}` },
      {
        text: job.createdAt
          ? formatSince(Date.parse(job.createdAt), Date.parse(capturedAt))
          : t("empty", "noneLower"),
      },
    ];
    return { cells };
  });
  return {
    id: "jobs",
    order: ORDER.own,
    title: t("action", "runs"),
    icon: iconSvg(kindIcon("Job")),
    count: jobs.length,
    unread,
    body: {
      type: "table",
      columns: [
        t("columns", "name"),
        t("columns", "status"),
        t("columns", "completions"),
        t("columns", "age"),
      ],
      rows,
      more: null,
    },
  };
}

/**
 * What the CronJob page adds to the shared report: when it last ran, its
 * template and the recent runs the Jobs tab already read.
 */
export function useCronJobShare(
  cronJob: CronJobDetailInfo | undefined,
  jobs: readonly JobInfo[],
  jobsError: unknown
): (frame: ShareFrame) => ShareContribution {
  const t = useT();
  return useCallback(
    (frame: ShareFrame): ShareContribution => {
      if (!cronJob) return {};
      const { capturedAt } = frame;
      const jobs_ = jobsSection(jobs, jobsError, capturedAt, t);
      return {
        status: cronJobStatusOf(cronJob, t),
        stats: cronJobStatsOf(cronJob, capturedAt, t),
        sections: [templateContainersSection(cronJob, t), jobs_],
      };
    },
    [cronJob, jobs, jobsError, t]
  );
}
