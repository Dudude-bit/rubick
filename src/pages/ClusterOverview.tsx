import { AlertCircle } from "lucide-react";

import { scopeLabel } from "@/lib/namespace-scope";
import { useClusterStore } from "@/stores/clusterStore";
import { useClusterInfo } from "@/hooks";
import { useScopedOverview } from "@/hooks/useClusterOverview";
import { ClusterFrontDoor } from "@/components/cluster/ClusterFrontDoor";
import { Section } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { HeaderSkeleton, StatsSkeleton } from "@/components/ui/skeleton";
import {
  NodesPanel,
  ProblemsPanel,
  SchedulerPanel,
  WarningsPanel,
  WorkloadsPanel,
} from "@/components/overview/health";
import { useT } from "@/i18n/useT";

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
  const t = useT();
  const { isConnected, namespaceScope } = useClusterStore();
  const { data: clusterInfo } = useClusterInfo();

  const { data: overview, isLoading, error, refetch } = useScopedOverview();

  // Not an empty overview but a different screen: with no cluster there
  // is no scope to be empty of anything, and the one thing the reader
  // needs is the list of clusters the kubeconfig already named.
  if (!isConnected) return <ClusterFrontDoor />;

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
            {t("empty", "couldNotReadClusterState")}
          </h2>
        </div>
        <p className="text-xs text-fg-mut">{error.message}</p>
        <div className="flex items-center gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t("action", "retry")}
          </Button>
        </div>
      </Section>
    );
  }

  if (!overview) return null;

  const scope = scopeLabel(namespaceScope, t);

  return (
    <div className="flex flex-col gap-[22px] animate-in fade-in duration-200">
      <ProblemsPanel
        problems={overview.problems}
        problemsTruncated={overview.problemsTruncated}
        pods={overview.pods}
        nodes={overview.nodes}
      />
      <WorkloadsPanel overview={overview} scope={scope} />
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
