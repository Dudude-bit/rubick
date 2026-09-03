import { podReadiness } from "@/lib/container-sequence";
import { silenceOf } from "@/lib/node-reporting";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import { ResourceType } from "@/lib/resource-registry";
import { ChildRows } from "./child-rows";
import type { PodInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

interface PodListCardProps {
  pods: PodInfo[];
  emptyMessage?: string;
  /** The pod list failed to read. Not the same as owning no pods. */
  error?: Error | null;
}

/** The pods a workload owns. */
export function PodListCard({ pods, emptyMessage, error }: PodListCardProps) {
  const t = useT();
  // A pod on a node that stopped reporting keeps whatever the kubelet last
  // wrote. Every other surface that draws a pod's status drops the colour for
  // that; these rows — the workload pages' Pods tab and the peek's — did not.
  const silent = useSilentNodes(pods.length > 0);
  return (
    <ChildRows
      emptyMessage={emptyMessage ?? t("empty", "noPodsForWorkload")}
      error={error}
      label={t("count", "podNoun", { n: 2 })}
      rows={pods.map((pod) => {
        const { ready, total } = podReadiness(pod);
        const restarts = pod.restartCount ?? 0;
        return {
          kind: ResourceType.Pod,
          name: pod.name,
          namespace: pod.namespace,
          status: pod.status?.display || "Unknown",
          unverified: silenceOf(pod.nodeName, silent) !== null,
          detail: (
            <>
              {ready}
              <span className="text-fg-fnt">/{total}</span>
              <span className="text-fg-fnt"> ready</span>
              {restarts > 0 && (
                <span className="text-warn"> · {restarts} restarts</span>
              )}
            </>
          ),
          timestamp: pod.createdAt,
        };
      })}
    />
  );
}
