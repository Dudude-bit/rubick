import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { useClusterInfo } from "@/hooks";
import { Section } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { HeaderSkeleton, StatsSkeleton } from "@/components/ui/skeleton";
import { normalizeTauriError } from "@/lib/error-utils";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import {
  NodesPanel,
  ProblemsPanel,
  SchedulerPanel,
  WarningsPanel,
  WorkloadsPanel,
} from "@/components/overview/health";

/**
 * The overview answers one question — "do I need to do something right
 * now?" — and the reading order answers it: what is broken, what this scope
 * is made of, how much room the scheduler has left, and what the nodes and
 * the event feed have been saying.
 *
 * The cluster identity is not repeated here: the header already carries the
 * context and namespace selectors, and a page title restating them was the
 * largest block on a screen whose first row is the point.
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
    );
  }

  if (!overview) return null;

  const scope = currentNamespace || "all namespaces";

  return (
    <div className="flex flex-col gap-[22px] animate-in fade-in duration-200">
      <ProblemsPanel
        problems={overview.problems}
        problemsTruncated={overview.problemsTruncated}
        podCount={overview.podCount}
        nodes={overview.nodes}
      />
      <WorkloadsPanel
        problems={overview.problems}
        problemsTruncated={overview.problemsTruncated}
        podCount={overview.podCount}
        nodes={overview.nodes}
        scope={scope}
      />
      <SchedulerPanel
        scheduler={overview.scheduler}
        metricsAvailable={overview.metricsAvailable}
      />
      <NodesPanel
        nodes={overview.nodes}
        version={clusterInfo?.server_version}
      />
      <WarningsPanel warnings={overview.warnings} />
    </div>
  );
}
