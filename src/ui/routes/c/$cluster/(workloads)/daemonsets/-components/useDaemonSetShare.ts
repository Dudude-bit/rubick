import { useCallback } from "react";

import type {
  ShareContribution,
  ShareFrame,
} from "@/components/share/contribution";
import { templateContainersSection } from "../../-components/containers-section";
import { podsSection } from "../../-components/pods-section";
import type { ReportStat } from "@/lib/report";
import { rolloutStatusOf } from "@/lib/workload-status";
import type { DaemonSetDetailInfo, PodInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

export function daemonSetStatsOf(
  daemonSet: DaemonSetDetailInfo,
  t: T
): ReportStat[] {
  const { desired, current, ready, upToDate, available } = daemonSet;
  return [
    {
      label: t("columns", "ready"),
      value: `${ready}/${desired}`,
      role: ready >= desired ? "ok" : "warn",
    },
    { label: t("columns", "current"), value: String(current) },
    {
      label: t("share", "wlUpToDate"),
      value: `${upToDate}/${desired}`,
      role: upToDate >= desired ? "ok" : "warn",
    },
    { label: t("share", "wlAvailable"), value: String(available) },
    {
      label: t("columns", "updateStrategy"),
      value: daemonSet.updateStrategy || "RollingUpdate",
    },
  ];
}

/**
 * What the DaemonSet page adds to the shared report: how many nodes it
 * covers, how many of those are on the current spec, its template and the
 * pods it runs, all already read for the Overview and the Pods tab.
 */
export function useDaemonSetShare(
  daemonSet: DaemonSetDetailInfo | undefined,
  pods: readonly PodInfo[],
  podsError: unknown
): (frame: ShareFrame) => ShareContribution {
  const t = useT();
  return useCallback(
    (frame: ShareFrame): ShareContribution => {
      if (!daemonSet) return {};
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
        status: rolloutStatusOf(
          daemonSet.ready,
          daemonSet.desired,
          daemonSet.rollout,
          t
        ),
        stats: daemonSetStatsOf(daemonSet, t),
        sections: [templateContainersSection(daemonSet, t), pods_],
      };
    },
    [daemonSet, pods, podsError, t]
  );
}
