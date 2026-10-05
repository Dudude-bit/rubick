import { useCallback } from "react";

import type {
  ShareContribution,
  ShareFrame,
} from "@/components/share/contribution";
import { templateContainersSection } from "../../-components/containers-section";
import { podsSection } from "../../-components/pods-section";
import { parseImageRef } from "@/lib/image-ref";
import type { ReportStat, ReportValue } from "@/lib/report";
import { ORDER, kindIcon, refOf, type PlacedSection } from "@/lib/report-parts";
import { iconSvg } from "@/lib/icon-svg";
import { formatSince } from "@/lib/utils";
import { rolloutStatusOf } from "@/lib/workload-status";
import type {
  DeploymentInfo,
  PodInfo,
  ReplicaSetInfo,
} from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

export function deploymentStatsOf(
  deployment: DeploymentInfo,
  revisions: readonly ReplicaSetInfo[],
  t: T
): ReportStat[] {
  const { desired, ready, updated, available } = deployment.replicas;
  const live = revisions.find(
    (rs) => rs.revision !== null && rs.revision === rs.currentRevision
  );
  const stats: ReportStat[] = [
    {
      label: t("columns", "ready"),
      value: `${ready}/${desired}`,
      role: ready >= desired ? "ok" : "warn",
    },
    { label: t("columns", "upToDateCount"), value: String(updated) },
    { label: t("share", "wlAvailable"), value: String(available) },
    {
      label: t("columns", "strategy"),
      value: deployment.strategy || "RollingUpdate",
    },
  ];
  if (live)
    stats.push({
      label: t("columns", "revision"),
      value: live.revision ?? "",
      ref: refOf({
        kind: "ReplicaSet",
        name: live.name,
        namespace: live.namespace,
      }),
    });
  return stats;
}

/**
 * The rollout: every ReplicaSet the page already read, newest first, with
 * the image tags that changed between them.
 */
export function revisionsSection(
  revisions: readonly ReplicaSetInfo[],
  capturedAt: string,
  t: T
): PlacedSection {
  const rows = revisions.map((rs) => {
    const tags = rs.containers
      .map((c) => parseImageRef(c.image)?.tag)
      .filter((tag): tag is string => Boolean(tag))
      .join(", ");
    const cells: ReportValue[] = [
      {
        text: rs.revision ?? rs.name,
        ref: refOf({
          kind: "ReplicaSet",
          name: rs.name,
          namespace: rs.namespace,
        }),
      },
      { text: `${rs.replicas.ready}/${rs.replicas.desired}` },
      { text: tags || t("empty", "noneLower"), mono: Boolean(tags) },
      {
        text: rs.createdAt
          ? formatSince(Date.parse(rs.createdAt), Date.parse(capturedAt))
          : t("empty", "noneLower"),
      },
    ];
    return { cells };
  });
  return {
    id: "revisions",
    order: ORDER.own,
    title: t("nav", "revisions"),
    icon: iconSvg(kindIcon("ReplicaSet")),
    count: revisions.length,
    body: {
      type: "table",
      columns: [
        t("columns", "revision"),
        t("columns", "ready"),
        t("columns", "image"),
        t("columns", "age"),
      ],
      rows,
      more: null,
    },
  };
}

/**
 * What the Deployment page adds to the shared report: the rollout numbers,
 * the revision that is live, the template's containers, the ReplicaSets and
 * the pods, all read already for the Overview and the Revisions tab.
 */
export function useDeploymentShare(
  deployment: DeploymentInfo | undefined,
  revisions: readonly ReplicaSetInfo[],
  pods: readonly PodInfo[],
  podsError: unknown
): (frame: ShareFrame) => ShareContribution {
  const t = useT();
  return useCallback(
    (frame: ShareFrame): ShareContribution => {
      if (!deployment) return {};
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
          deployment.replicas.ready,
          deployment.replicas.desired,
          deployment.rollout,
          t
        ),
        stats: deploymentStatsOf(deployment, revisions, t),
        sections: [
          templateContainersSection(deployment, t),
          revisionsSection(revisions, frame.capturedAt, t),
          pods_,
        ],
      };
    },
    [deployment, revisions, pods, podsError, t]
  );
}
