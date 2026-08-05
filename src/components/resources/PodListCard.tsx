import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { RealtimeAge } from "@/components/ui/realtime";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { PodInfo } from "@/generated/types";

interface PodListCardProps {
  pods: PodInfo[];
  emptyMessage?: string;
}

function getStatusVariant(
  status: string
): "success" | "warning" | "destructive" | "default" {
  switch (status) {
    case "Running":
      return "success";
    case "Succeeded":
      return "default";
    case "Pending":
      return "warning";
    default:
      return "destructive";
  }
}

export function PodListCard({
  pods,
  emptyMessage = "No pods found",
}: PodListCardProps) {
  return (
    <div className="flex flex-col divide-y divide-hair">
      {pods.map((pod) => {
        const readyCount = pod.containers?.filter((c) => c.ready).length ?? 0;
        const totalCount = pod.containers?.length ?? 0;
        const readyText = `${readyCount}/${totalCount}`;
        const status = pod.status?.phase || "Unknown";

        return (
          <Link
            key={pod.name}
            to={`/${toPlural(ResourceType.Pod)}/${pod.namespace}/${pod.name}`}
            className="flex items-center justify-between px-2 py-2.5 hover:bg-hover transition-colors"
          >
            <div className="flex items-center gap-3">
              <Badge variant={getStatusVariant(status)}>{status}</Badge>
              <span className="font-medium">{pod.name}</span>
            </div>
            <div className="flex items-center gap-4 text-sm text-fg-mut">
              <span>Ready: {readyText}</span>
              <span>Restarts: {pod.restartCount ?? 0}</span>
              <RealtimeAge timestamp={pod.createdAt} />
            </div>
          </Link>
        );
      })}
      {pods.length === 0 && (
        <p className="text-center text-fg-mut py-4">{emptyMessage}</p>
      )}
    </div>
  );
}
