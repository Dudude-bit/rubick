import { podReadiness } from "@/lib/container-sequence";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, kindIcon, refOf, type PlacedSection } from "@/lib/report-parts";
import { statusRole } from "@/lib/status-role";
import type { PodInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";

/** A file is read, not scrolled: past this the app is the place. */
const MAX_PODS = 200;

export interface PodsShare {
  pods: readonly PodInfo[];
  /** The list read failed; not the same as the workload owning no pods. */
  error?: unknown;
}

/**
 * The pods a workload owns, as a table: the same columns `PodListCard`
 * draws, so a reader who has seen the tab recognises the shape.
 */
export function podsSection(share: PodsShare, t: T): PlacedSection {
  const unread = share.error ? t("empty", "couldNotReadWorkloadPods") : null;
  const kept = share.pods.slice(0, MAX_PODS);
  const rows = kept.map((pod) => {
    const { ready, total } = podReadiness(pod);
    const restarts = pod.restartCount ?? 0;
    const cells: ReportValue[] = [
      {
        text: pod.name,
        ref: refOf({ kind: "Pod", name: pod.name, namespace: pod.namespace }),
      },
      { text: pod.status.display, role: statusRole(pod.status.display) },
      { text: `${ready}/${total}` },
      { text: String(restarts), role: restarts > 0 ? "warn" : undefined },
    ];
    return { cells };
  });
  return {
    id: "pods",
    order: ORDER.own,
    title: t("columns", "pods"),
    icon: iconSvg(kindIcon("Pod")),
    count: share.pods.length,
    unread,
    body: {
      type: "table",
      columns: [
        t("columns", "name"),
        t("columns", "status"),
        t("columns", "ready"),
        t("columns", "restarts"),
      ],
      rows,
      more:
        share.pods.length > kept.length
          ? t("share", "rowsMore", { n: share.pods.length - kept.length })
          : null,
    },
  };
}
