/**
 * The four-card header on the Pod detail page: Info, Status, CPU,
 * Memory. Pure presentational — receives the pod and its merged
 * metrics, returns the grid.
 */

import { InfoCard, InfoRow } from "@/components/resources/ResourceDetailLayout";
import { MetricCard } from "@/components/ui/metric-card";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import type { PodWithMetrics } from "@/lib/metrics";
import type { PodInfo } from "@/generated/types";

interface PodInfoCardsProps {
  pod: PodInfo;
  podWithMetrics: PodWithMetrics | null;
}

export function PodInfoCards({ pod, podWithMetrics }: PodInfoCardsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <InfoCard title="Info">
        <InfoRow label="Node" value={pod.nodeName || "-"} />
        <InfoRow label="Pod IP" value={pod.podIp || "-"} />
        <InfoRow label="Host IP" value={pod.hostIp || "-"} />
      </InfoCard>

      <InfoCard title="Status">
        <InfoRow label="Phase" value={pod.status.phase} />
        <InfoRow
          label="Started"
          value={pod.createdAt ? new Date(pod.createdAt).toLocaleString() : "-"}
        />
        <InfoRow label="Restart Count" value={pod.restartCount} />
      </InfoCard>

      {podWithMetrics && (
        <>
          <MetricCard
            title="CPU Usage"
            used={podWithMetrics.cpuMillicores}
            request={
              podWithMetrics.cpuRequests
                ? parseCPU(podWithMetrics.cpuRequests)
                : null
            }
            limit={
              podWithMetrics.cpuLimits
                ? parseCPU(podWithMetrics.cpuLimits)
                : null
            }
            type="cpu"
            showProgressBar
          />

          <MetricCard
            title="Memory Usage"
            used={podWithMetrics.memoryBytes}
            request={
              podWithMetrics.memoryRequests
                ? parseMemory(podWithMetrics.memoryRequests)
                : null
            }
            limit={
              podWithMetrics.memoryLimits
                ? parseMemory(podWithMetrics.memoryLimits)
                : null
            }
            type="memory"
            showProgressBar
          />
        </>
      )}
    </div>
  );
}
