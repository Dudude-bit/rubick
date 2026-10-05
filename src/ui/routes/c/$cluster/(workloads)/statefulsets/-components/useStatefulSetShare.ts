import { useCallback } from "react";

import type {
  ShareContribution,
  ShareFrame,
} from "@/components/share/contribution";
import { templateContainersSection } from "../../-components/containers-section";
import { podsSection } from "../../-components/pods-section";
import type { ReportStat } from "@/lib/report";
import { refOf } from "@/lib/report-parts";
import { rolloutStatusOf } from "@/lib/workload-status";
import type { PodInfo, StatefulSetDetailInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

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
): (frame: ShareFrame) => ShareContribution {
  const t = useT();
  return useCallback(
    (frame: ShareFrame): ShareContribution => {
      if (!statefulSet) return {};
      const { desired, ready } = statefulSet.replicas;
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
        status: rolloutStatusOf(ready, desired, statefulSet.rollout, t),
        stats: statefulSetStatsOf(statefulSet, t),
        sections: [templateContainersSection(statefulSet, t), pods_],
      };
    },
    [statefulSet, pods, podsError, t]
  );
}
