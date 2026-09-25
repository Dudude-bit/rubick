import { useCallback } from "react";

import type { ShareContribution } from "@/components/share/contribution";
import { templateContainersSection } from "@/components/share/containers-section";
import { podsSection } from "@/components/share/pods-section";
import type { ReportStat } from "@/lib/report";
import { refOf } from "@/lib/report-parts";
import { statusRole } from "@/lib/status-role";
import { workloadStatus } from "@/lib/workload-status";
import type { PodInfo, StatefulSetDetailInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

export function statefulSetStatusOf(ready: number, desired: number, t: T) {
  return {
    text: t("count", "slashReady", { n: ready, total: desired }),
    role: statusRole(workloadStatus({ ready, desired })),
  };
}

export function statefulSetStatsOf(
  statefulSet: StatefulSetDetailInfo,
  t: T
): ReportStat[] {
  const { desired, current, ready, updated } = statefulSet.replicas;
  const stats: ReportStat[] = [
    {
      label: t("columns", "ready"),
      value: `${ready}/${desired}`,
      role: ready >= desired ? "ok" : "warn",
    },
    { label: t("columns", "current"), value: String(current) },
    { label: t("columns", "updated"), value: String(updated) },
  ];
  stats.push(
    statefulSet.serviceName
      ? {
          label: t("columns", "governingService"),
          value: statefulSet.serviceName,
          ref: refOf({
            kind: "Service",
            name: statefulSet.serviceName,
            namespace: statefulSet.namespace,
          }),
        }
      : {
          label: t("columns", "governingService"),
          value: t("empty", "noGoverningService"),
          role: "warn",
        }
  );
  return stats;
}

/**
 * What the StatefulSet page adds to the shared report: the ordinal replica
 * count, its governing service, its template and the pods it runs, all
 * already read for the Overview and the Pods tab.
 */
export function useStatefulSetShare(
  statefulSet: StatefulSetDetailInfo | undefined,
  pods: readonly PodInfo[],
  podsError: unknown
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!statefulSet) return {};
    const { desired, ready } = statefulSet.replicas;
    const pods_ = podsSection({ pods, error: podsError }, t);
    return {
      status: statefulSetStatusOf(ready, desired, t),
      stats: statefulSetStatsOf(statefulSet, t),
      notRead: pods_.unread ? [pods_.unread] : [],
      sections: [templateContainersSection(statefulSet, t), pods_],
    };
  }, [statefulSet, pods, podsError, t]);
}
