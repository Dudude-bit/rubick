import { useCallback } from "react";

import type { ShareContribution } from "@/components/share/contribution";
import { templateContainersSection } from "@/components/share/containers-section";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportStat, ReportValue } from "@/lib/report";
import { ORDER, kindIcon, refOf, type PlacedSection } from "@/lib/report-parts";
import { statusRole } from "@/lib/status-role";
import { formatDate, formatSince } from "@/lib/utils";
import type { CronJobDetailInfo, JobInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

export function cronJobStatusOf(cronJob: CronJobDetailInfo) {
  const text = cronJob.suspend ? "Suspended" : "Active";
  return { text, role: statusRole(text) };
}

export function cronJobStatsOf(
  cronJob: CronJobDetailInfo,
  capturedAt: string,
  t: T
): ReportStat[] {
  const stats: ReportStat[] = [
    { label: t("columns", "schedule"), value: cronJob.schedule || "–" },
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
          value: formatDate(cronJob.lastSuccessfulTime) ?? "–",
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
      { text: job.status || "Unknown", role: statusRole(job.status || "") },
      { text: `${job.succeeded}/${job.completions ?? 1}` },
      {
        text: job.createdAt
          ? formatSince(Date.parse(job.createdAt), Date.parse(capturedAt))
          : "–",
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
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!cronJob) return {};
    const capturedAt = new Date().toISOString();
    const jobs_ = jobsSection(jobs, jobsError, capturedAt, t);
    return {
      status: cronJobStatusOf(cronJob),
      stats: cronJobStatsOf(cronJob, capturedAt, t),
      notRead: jobs_.unread ? [jobs_.unread] : [],
      sections: [templateContainersSection(cronJob, t), jobs_],
    };
  }, [cronJob, jobs, jobsError, t]);
}
