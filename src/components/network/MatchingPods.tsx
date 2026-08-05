import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "react-router-dom";
import { Circle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { ResourceType } from "@/lib/resource-registry";

interface MatchingPodsProps {
  namespace: string;
  selector: Record<string, string>;
}

function getPodStatusColor(phase: string): string {
  switch (phase) {
    case "Running":
      return "text-ok";
    case "Pending":
      return "text-warn";
    case "Succeeded":
      return "text-info";
    case "Failed":
      return "text-err";
    default:
      return "text-fg-fnt";
  }
}

export function MatchingPods({ namespace, selector }: MatchingPodsProps) {
  const {
    data: pods,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["pods-by-selector", namespace, selector],
    queryFn: () =>
      commands.listPods({
        namespace,
        selector,
        statusFilter: null,
        nodeName: null,
        labelSelector: null,
        fieldSelector: null,
        limit: null,
      }),
    enabled: Object.keys(selector).length > 0,
  });

  if (Object.keys(selector).length === 0) {
    return (
      <Section>
        <SectionHeader title="Matching Pods" />
        <p className="text-sm text-fg-mut">No selector defined</p>
      </Section>
    );
  }

  // Count pods by status
  const statusCounts =
    pods?.reduce(
      (acc, pod) => {
        const phase = pod.status.phase || "Unknown";
        acc[phase] = (acc[phase] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    ) || {};

  const statusSummary = Object.entries(statusCounts)
    .map(([phase, count]) => `${count} ${phase.toLowerCase()}`)
    .join(", ");

  return (
    <Section>
      <SectionHeader
        title="Matching Pods"
        count={pods?.length}
        description={pods && pods.length > 0 ? statusSummary : undefined}
      />
      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error ? (
        <p className="text-sm text-err">Failed to load pods: {String(error)}</p>
      ) : pods && pods.length > 0 ? (
        <SectionBody className="flex flex-col divide-y divide-hair">
          {pods.map((pod) => (
            <Link
              key={pod.uid}
              to={getResourceDetailUrl(
                ResourceType.Pod,
                pod.name,
                pod.namespace
              )}
              className="flex items-center justify-between px-2 py-2.5 hover:bg-hover transition-colors"
            >
              <div className="flex items-center gap-3">
                <Circle
                  className={`h-3 w-3 fill-current ${getPodStatusColor(pod.status.phase || "Unknown")}`}
                />
                <span className="font-medium">{pod.name}</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-fg-mut">
                <span>{pod.status.phase}</span>
                {pod.podIp && (
                  <code className="font-mono text-xs">{pod.podIp}</code>
                )}
              </div>
            </Link>
          ))}
        </SectionBody>
      ) : (
        <p className="text-sm text-fg-mut">No pods match this selector</p>
      )}
    </Section>
  );
}
