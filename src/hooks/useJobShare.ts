import { useCallback } from "react";

import type { ShareContribution } from "@/components/share/contribution";
import { templateContainersSection } from "@/components/share/containers-section";
import { podsSection } from "@/components/share/pods-section";
import type { ReportStat } from "@/lib/report";
import { statusRole } from "@/lib/status-role";
import type { JobDetailInfo, PodInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

/** Wall-clock time the job has been running, or ran for, the same reading `JobDetail` shows. */
function duration(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function jobStatusOf(job: JobDetailInfo) {
  return { text: job.status, role: statusRole(job.status) };
}

export function jobStatsOf(job: JobDetailInfo, t: T): ReportStat[] {
  const completions = job.completions ?? 1;
  const succeeded = job.succeeded ?? 0;
  const failed = job.failed ?? 0;
  const active = job.active ?? 0;
  const ran = duration(job.startTime, job.completionTime);
  const stats: ReportStat[] = [
    {
      label: t("columns", "completions"),
      value: `${succeeded}/${completions}`,
      role: succeeded >= completions ? "ok" : undefined,
    },
    {
      label: t("share", "wlParallelism"),
      value: String(job.parallelism ?? 1),
    },
    { label: t("columns", "active"), value: String(active) },
    {
      label: t("share", "wlFailed"),
      value: String(failed),
      role: failed > 0 ? "warn" : undefined,
    },
  ];
  if (ran) stats.push({ label: t("action", "ranFor"), value: ran });
  return stats;
}

/**
 * What the Job page adds to the shared report: how many completions it
 * still needs, how it has been running, its template and the pods it ran –
 * all already read for the Overview and the Pods tab.
 */
export function useJobShare(
  job: JobDetailInfo | undefined,
  pods: readonly PodInfo[],
  podsError: unknown
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!job) return {};
    const pods_ = podsSection({ pods, error: podsError }, t);
    return {
      status: jobStatusOf(job),
      stats: jobStatsOf(job, t),
      notRead: pods_.unread ? [pods_.unread] : [],
      sections: [templateContainersSection(job, t), pods_],
    };
  }, [job, pods, podsError, t]);
}
