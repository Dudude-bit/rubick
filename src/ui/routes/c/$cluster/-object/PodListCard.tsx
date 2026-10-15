import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { podReadiness } from "@/lib/container-sequence";
import { restartsAreNews } from "@/lib/crash-loop";
import { silenceOf } from "@/lib/node-reporting";
import { podRole, podStatusTitle } from "@/lib/share/pod-status";
import { withRestartsBy } from "@/lib/pod-status";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import { ResourceType } from "@/lib/resource-registry";
import { ChildRows, type ChildRow } from "./child-rows";
import { EndedAgo } from "./EndedAgo";
import type { PodInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";
import { parts } from "@/i18n/parts";

interface PodListCardProps {
  pods: PodInfo[];
  emptyMessage?: string;
  /** The pod list failed to read. Not the same as owning no pods. */
  error?: Error | null;
  onRetry?: () => void;
  /** Not read yet for this workload: not the same as owning no pods either. */
  pending?: boolean;
}

function rowOf(
  pod: PodInfo,
  silent: ReturnType<typeof useSilentNodes>,
  t: T
): ChildRow {
  const { ready, total } = podReadiness(pod);
  const restarts = pod.restartCount ?? 0;
  return {
    kind: ResourceType.Pod,
    name: pod.name,
    namespace: pod.namespace,
    status: pod.status?.display || "Unknown",
    role: podRole(pod, null),
    statusTitle: podStatusTitle(pod, silenceOf(pod.nodeName, silent), t),
    unverified: silenceOf(pod.nodeName, silent) !== null,
    detail: (
      <>
        <span className="text-fg-fnt">
          {parts(t("count", "readyFraction", { total }), {
            ready: <span className="text-fg-mut">{ready}</span>,
          })}
        </span>
        {pod.status.failedAt && (
          <>
            {" · "}
            <EndedAgo at={pod.status.failedAt} className="text-fg-mut" />
          </>
        )}
        {restarts > 0 && (
          <span className={restartsAreNews(pod) ? "text-warn" : "text-fg-mut"}>
            {" · "}
            {withRestartsBy(
              t("count", "restartsPlain", { n: restarts }),
              pod.restartsBy,
              t
            )}
          </span>
        )}
      </>
    ),
    timestamp: pod.createdAt,
  };
}

/** The pods a workload owns: the ones it runs, then the ones its controller replaced, folded under their count. */
export function PodListCard({
  pods,
  emptyMessage,
  error,
  onRetry,
  pending,
}: PodListCardProps) {
  const t = useT();
  const [showReplaced, setShowReplaced] = useState(false);
  // A pod on a node that stopped reporting keeps whatever the kubelet last
  // wrote. Every other surface that draws a pod's status drops the colour for
  // that; these rows — the workload pages' Pods tab and the peek's — did not.
  const silent = useSilentNodes(pods.length > 0);
  const replaced = pods.filter((pod) => pod.status.gone === "replaced");
  const run = pods.filter((pod) => pod.status.gone !== "replaced");
  return (
    <>
      <ChildRows
        emptyMessage={emptyMessage ?? t("empty", "noPodsForWorkload")}
        error={error}
        onRetry={onRetry}
        pending={pending}
        label={t("count", "podNoun", { n: 2 })}
        rows={run.map((pod) => rowOf(pod, silent, t))}
      />
      {replaced.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showReplaced}
            onClick={() => setShowReplaced(!showReplaced)}
            title={t("count", "replacedPodsHint")}
            className="flex items-center gap-1 rounded-[5px] px-1.5 py-1 text-[11px] text-fg-fnt hover:bg-hover hover:text-fg-mut"
          >
            {showReplaced ? (
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            )}
            {t("count", "replacedPods", { n: replaced.length })}
          </button>
          {showReplaced && (
            <ChildRows rows={replaced.map((pod) => rowOf(pod, silent, t))} />
          )}
        </>
      )}
    </>
  );
}
