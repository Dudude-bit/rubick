import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { useClusterInfo } from "@/hooks";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { HeaderSkeleton, StatsSkeleton } from "@/components/ui/skeleton";
import { normalizeTauriError } from "@/lib/error-utils";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { OverviewHeader } from "@/components/overview";
import {
  NodesPanel,
  ProblemsPanel,
  SchedulerPanel,
  WarningsPanel,
} from "@/components/overview/health";

/**
 * The overview answers one question — "do I need to do something right
 * now?" — and reorders itself around the answer.
 *
 * When something is broken, the problem list owns the top of the screen and
 * everything else compresses into supporting context. When nothing is, that
 * list collapses to a single line and the screen becomes an orientation
 * view: what this cluster is, how it is laid out, how much room is left.
 *
 * It deliberately does not show object counts or top-consumers. Neither
 * answers the question, and both crowd out what does.
 */
export function ClusterOverview() {
  const { isConnected, currentContext, currentNamespace } = useClusterStore();
  const { data: clusterInfo } = useClusterInfo();

  const {
    data: overview,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["cluster-overview", currentContext, currentNamespace],
    queryFn: async () => {
      try {
        return await commands.getClusterOverview(currentNamespace || null);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: isConnected,
    staleTime: STALE_TIMES.overview,
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_INTERVALS.overview,
    refetchOnWindowFocus: false,
  });

  const subtitle = useMemo(() => {
    const parts = [
      currentNamespace ? `Namespace: ${currentNamespace}` : "All namespaces",
    ];
    if (clusterInfo?.server_version) {
      parts.push(`Kubernetes ${clusterInfo.server_version}`);
    }
    if (clusterInfo?.platform) parts.push(clusterInfo.platform);
    if (overview) parts.push(`${overview.podCount} pods`);
    return parts.join(" • ");
  }, [clusterInfo, currentNamespace, overview]);

  if (!isConnected) {
    return (
      <div className="flex h-full items-center justify-center">
        <Section className="max-w-sm text-center">
          <h1 className="text-lg font-semibold tracking-tight">
            Welcome to K8s GUI
          </h1>
          <p className="text-sm text-fg-mut">
            Select a cluster from the header to get started.
          </p>
        </Section>
      </div>
    );
  }

  // Skeleton only on the first load — a refetch keeps the previous state on
  // screen so the layout never flashes empty while polling.
  if (isLoading && !overview) {
    return (
      <div className="space-y-6 animate-in fade-in duration-200">
        <HeaderSkeleton />
        <StatsSkeleton count={2} />
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="space-y-6">
        <OverviewHeader
          title={currentContext || "Cluster Overview"}
          subtitle={subtitle}
        />
        <Section>
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-err" aria-hidden="true" />
            <h2 className="text-[13px] font-semibold tracking-tight text-err">
              Could not read cluster state
            </h2>
          </div>
          <p className="text-xs text-fg-mut">{error.message}</p>
          <div className="flex items-center gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        </Section>
      </div>
    );
  }

  if (!overview) return null;

  const hasProblems = overview.problems.length > 0;

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-200">
      <OverviewHeader
        title={currentContext || "Cluster Overview"}
        subtitle={subtitle}
      />

      <ProblemsPanel
        problems={overview.problems}
        problemsTruncated={overview.problemsTruncated}
        podCount={overview.podCount}
      />

      {hasProblems ? (
        // Triage layout: the problem list above is the work queue, and these
        // two answer the follow-up questions it raises — "is the cluster out
        // of room?" and "what else has been complaining?".
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <SchedulerPanel
              scheduler={overview.scheduler}
              metricsAvailable={overview.metricsAvailable}
            />
            <WarningsPanel warnings={overview.warnings} />
          </div>
          <NodesPanel nodes={overview.nodes} />
        </>
      ) : (
        // Orientation layout: nothing is on fire, so lead with what this
        // cluster is made of.
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <NodesPanel nodes={overview.nodes} />
            <SchedulerPanel
              scheduler={overview.scheduler}
              metricsAvailable={overview.metricsAvailable}
            />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <NamespacesPanel namespaces={overview.namespaces} />
            <WarningsPanel warnings={overview.warnings} />
          </div>
        </>
      )}
    </div>
  );
}

function NamespacesPanel({
  namespaces,
}: {
  namespaces: { name: string; podCount: number }[];
}) {
  if (namespaces.length === 0) return null;
  const busiest = namespaces.slice(0, 8);

  return (
    <Section>
      <SectionHeader
        title="Namespaces with workloads"
        count={namespaces.length}
      />
      <SectionBody>
        {busiest.map((ns) => (
          <div
            key={ns.name}
            className="flex items-center justify-between border-b border-hair px-2 py-2 text-sm last:border-b-0"
          >
            <span className="font-mono">{ns.name}</span>
            <span className="text-xs text-fg-mut">{ns.podCount} pods</span>
          </div>
        ))}
      </SectionBody>
    </Section>
  );
}
