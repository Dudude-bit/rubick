import { useCallback } from "react";

import type {
  ShareContribution,
  ShareFrame,
} from "@/components/share/contribution";
import { templateContainersSection } from "../../-components/containers-section";
import { podsSection } from "../../-components/pods-section";
import type { ReportStat } from "@/lib/report";
import { statusRole } from "@/lib/status-role";
import { jobRanFor } from "../../../-object/job-end";
import type { JobDetailInfo, PodInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

export function jobStatusOf(job: JobDetailInfo) {
  return { text: job.status, role: statusRole(job.status) };
}

export function jobStatsOf(
  job: JobDetailInfo,
  capturedAt: string,
  t: T
): ReportStat[] {
  const completions = job.completions ?? 1;
  const succeeded = job.succeeded ?? 0;
  const failed = job.failed ?? 0;
  const active = job.active ?? 0;
  const ran = jobRanFor(job, Date.parse(capturedAt));
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
): (frame: ShareFrame) => ShareContribution {
  const t = useT();
  return useCallback(
    (frame: ShareFrame): ShareContribution => {
      if (!job) return {};
      const pods_ = podsSection(
        {
          pods,
          error: podsError,
          silent: frame.silent,
          capturedAt: frame.capturedAt,
        },
        t
      );
      return {
        status: jobStatusOf(job),
        stats: jobStatsOf(job, frame.capturedAt, t),
        sections: [templateContainersSection(job, t), pods_],
      };
    },
    [job, pods, podsError, t]
  );
}
