import { podReadiness } from "@/lib/container-sequence";
import { ResourceType } from "@/lib/resource-registry";
import { ChildRows } from "./child-rows";
import type { PodInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

interface PodListCardProps {
  pods: PodInfo[];
  emptyMessage?: string;
}

/** The pods a workload owns. */
export function PodListCard({ pods, emptyMessage }: PodListCardProps) {
  const t = useT();
  return (
    <ChildRows
      emptyMessage={emptyMessage ?? t("empty", "noPodsForWorkload")}
      rows={pods.map((pod) => {
        const { ready, total } = podReadiness(pod);
        const restarts = pod.restartCount ?? 0;
        return {
          kind: ResourceType.Pod,
          name: pod.name,
          namespace: pod.namespace,
          status: pod.status?.display || "Unknown",
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
