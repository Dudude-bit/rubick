import { ResourceType } from "@/lib/resource-registry";
import { ChildRows } from "./child-rows";
import type { PodInfo } from "@/generated/types";

interface PodListCardProps {
  pods: PodInfo[];
  emptyMessage?: string;
}

/** The pods a workload owns. */
export function PodListCard({
  pods,
  emptyMessage = "No pods for this workload",
}: PodListCardProps) {
  return (
    <ChildRows
      emptyMessage={emptyMessage}
      rows={pods.map((pod) => {
        const total = pod.containers?.length ?? 0;
        const ready = pod.containers?.filter((c) => c.ready).length ?? 0;
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
