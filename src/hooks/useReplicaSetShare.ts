import { useCallback } from "react";

import type { ShareContribution } from "@/components/share/contribution";
import { templateContainersSection } from "@/components/share/containers-section";
import { podsSection } from "@/components/share/pods-section";
import type { ReportStat } from "@/lib/report";
import { refOf } from "@/lib/report-parts";
import { statusRole } from "@/lib/status-role";
import type {
  OwnerReference,
  PodInfo,
  ReplicaSetInfo,
} from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

export type ReplicaSetStanding = "unversioned" | "current" | "superseded";

export function replicaSetStatusOf(
  standing: ReplicaSetStanding,
  ready: number,
  desired: number,
  t: T
) {
  if (standing === "unversioned")
    return {
      text: t("count", "slashReady", { n: ready, total: desired }),
      role: statusRole(ready < desired ? "Degraded" : "Ready"),
    };
  return {
    text:
      standing === "current"
        ? t("empty", "currentRevisionLower")
        : t("empty", "supersededLower"),
    role: statusRole(standing === "current" ? "Current" : "Superseded"),
  };
}

export function replicaSetStatsOf(
  replicaSet: ReplicaSetInfo,
  owner: OwnerReference | undefined,
  retired: number,
  t: T
): ReportStat[] {
  const { desired, current, ready } = replicaSet.replicas;
  const stats: ReportStat[] = [
    {
      label: t("columns", "ready"),
      value: `${ready}/${desired}`,
      role: ready >= desired ? "ok" : "warn",
    },
    { label: t("columns", "current"), value: String(current) },
  ];
  if (replicaSet.revision !== null)
    stats.push({
      label: t("columns", "revision"),
      value: replicaSet.revision,
      note:
        retired > 0 ? t("count", "otherRevisionsAtZero", { n: retired }) : null,
    });
  if (owner)
    stats.push({
      label: t("columns", "ownedBy"),
      value: owner.name,
      ref: refOf({
        kind: owner.kind,
        name: owner.name,
        namespace: replicaSet.namespace,
      }),
    });
  return stats;
}

/**
 * What the ReplicaSet page adds to the shared report: which revision this
 * is, what owns it, its template and the pods it runs, all already read
 * for the Overview and the Pods tab.
 */
export function useReplicaSetShare(
  replicaSet: ReplicaSetInfo | undefined,
  standing: ReplicaSetStanding,
  owner: OwnerReference | undefined,
  retired: number,
  pods: readonly PodInfo[],
  podsError: unknown
): () => ShareContribution {
  const t = useT();
  return useCallback((): ShareContribution => {
    if (!replicaSet) return {};
    const { desired, ready } = replicaSet.replicas;
    const pods_ = podsSection({ pods, error: podsError }, t);
    return {
      status: replicaSetStatusOf(standing, ready, desired, t),
      stats: replicaSetStatsOf(replicaSet, owner, retired, t),
      notRead: pods_.unread ? [pods_.unread] : [],
      sections: [templateContainersSection(replicaSet, t), pods_],
    };
  }, [replicaSet, standing, owner, retired, pods, podsError, t]);
}
