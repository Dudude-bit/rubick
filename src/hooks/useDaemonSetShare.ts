import { useCallback } from "react";

import type { ShareContribution } from "@/components/share/contribution";
import { templateContainersSection } from "@/components/share/containers-section";
import { podsSection } from "@/components/share/pods-section";
import type { ReportStat } from "@/lib/report";
import { statusRole } from "@/lib/status-role";
import { workloadStatus } from "@/lib/workload-status";
import type { DaemonSetDetailInfo, PodInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

export function daemonSetStatusOf(
  ready: number,
  desired: number,
  rollingOut: boolean,
  t: T
) {
  const text = t("count", "slashReady", { n: ready, total: desired });
  return {
    text: rollingOut ? `${t("action", "rollingOut")} · ${text}` : text,
    role: statusRole(workloadStatus({ ready, desired })),
  };
}

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
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!daemonSet) return {};
    const rollingOut = daemonSet.upToDate < daemonSet.desired;
    const pods_ = podsSection({ pods, error: podsError }, t);
    return {
      status: daemonSetStatusOf(
        daemonSet.ready,
        daemonSet.desired,
        rollingOut,
        t
      ),
      stats: daemonSetStatsOf(daemonSet, t),
      notRead: pods_.unread ? [pods_.unread] : [],
      sections: [templateContainersSection(daemonSet, t), pods_],
    };
  }, [daemonSet, pods, podsError, t]);
}
