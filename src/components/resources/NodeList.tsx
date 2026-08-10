import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useClusterStore } from "@/stores/clusterStore";
import { StatusBadge } from "@/components/ui/status-badge";
import { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { Eye, Shield, ShieldOff, AlertTriangle } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { QuickAction } from "@/components/ui/quick-actions";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { MetricValue } from "@/components/ui/metric-value";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { useCallback, useMemo, useState } from "react";
import { commands } from "@/lib/commands";
import { useMetrics } from "@/hooks/useMetrics";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { MetricsStatusBanner } from "@/components/metrics";
import { ResourceList } from "@/components/resources/ResourceList";
import { createNameColumn } from "@/components/resources/columns";
import { SpotMark } from "@/components/resources/spot-mark";
import type { RowGrouping } from "@/components/ui/row-grouping";
import { describePool, poolFacts, poolOf, spotMark } from "@/lib/node-pool";
import type { NodeInfo } from "@/generated/types";
import { STALE_TIMES } from "@/lib/refresh";
import { queryKeys } from "@/lib/query-keys";
import { RealtimeAge } from "@/components/ui/realtime";
import { getResourceRowId } from "@/lib/table-utils";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { DrainDialog } from "@/components/resources/drain-dialog";

/**
 * Nodes, grouped by the pool the cloud says made them.
 *
 * On a managed cluster this is the difference between forty flat rows and
 * three pools of known machines in known places, half of them disposable. On
 * every other cluster `poolOf` returns null for every node, no group reaches
 * the minimum, and the page is exactly the flat list it always was.
 */
const poolGrouping: RowGrouping<NodeInfo> = {
  keyOf: poolOf,
  caption: (pool, nodes) => {
    const facts = poolFacts(nodes);
    const spot = spotMark(facts);
    return (
      <span className="inline-flex items-baseline gap-2">
        <span className="font-mono text-fg-mid">{pool}</span>
        <span>{describePool(facts)}</span>
        {spot && <SpotMark says={spot} />}
      </span>
    );
  },
};

export function NodeList() {
  const { isConnected } = useClusterStore();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const queryKey = useMemo(
    () => queryKeys.resources(ResourceType.Node, null),
    []
  );
  const subscribeNodes = useCallback(() => commands.subscribeNodeWatch(), []);

  const [watchFailed, setWatchFailed] = useState(false);
  const handleWatchError = useCallback(
    (err: string) => {
      if (watchFailed) return;
      setWatchFailed(true);
      toast({
        title: "Real-time updates unavailable",
        description: `Nodes: falling back to periodic refresh. ${err}`,
      });
    },
    [toast, watchFailed]
  );
  useResourceWatch<NodeInfo>({
    enabled: isConnected,
    subscribe: subscribeNodes,
    queryKey,
    onError: handleWatchError,
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });

  const { nodeMetrics, nodeStatus } = useMetrics({
    includePods: false,
    includeCluster: false,
    enabled: isConnected,
  });

  const nodeMetricsByName = useMemo(() => {
    const metricsMap = new Map<string, (typeof nodeMetrics)[number]>();
    for (const metric of nodeMetrics) {
      metricsMap.set(metric.name, metric);
    }
    return metricsMap;
  }, [nodeMetrics]);

  const cordonMutation = useMutation({
    mutationFn: (nodeName: string) => commands.cordonNode(nodeName),
    onSuccess: (_, nodeName) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.resources(ResourceType.Node, null),
      });
      toast({
        title: "Node cordoned",
        description: `Node ${nodeName} has been cordoned.`,
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to cordon node: ${error}`,
        variant: "destructive",
      });
    },
  });

  const uncordonMutation = useMutation({
    mutationFn: (nodeName: string) => commands.uncordonNode(nodeName),
    onSuccess: (_, nodeName) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.resources(ResourceType.Node, null),
      });
      toast({
        title: "Node uncordoned",
        description: `Node ${nodeName} has been uncordoned.`,
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to uncordon node: ${error}`,
        variant: "destructive",
      });
    },
  });

  const drainMutation = useMutation({
    mutationFn: (nodeName: string) => commands.drainNode(nodeName, true, true),
    onSuccess: (_, nodeName) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.resources(ResourceType.Node, null),
      });
      toast({
        title: "Node drained",
        description: `Node ${nodeName} has been drained.`,
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to drain node: ${error}`,
        variant: "destructive",
      });
    },
  });

  const [draining, setDraining] = useState<string | null>(null);

  const columns: ColumnDef<NodeInfo>[] = useMemo(
    () => [
      createNameColumn<NodeInfo>(ResourceType.Node),
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const ready = row.original.status.ready;
          return <StatusBadge status={ready ? "Ready" : "NotReady"} />;
        },
      },
      {
        accessorKey: "roles",
        header: "Roles",
        cell: ({ row }) => (
          <span className="flex flex-wrap items-baseline gap-x-2 text-fg-mut">
            {row.original.roles.length === 0 ? (
              <span className="text-fg-fnt">—</span>
            ) : (
              row.original.roles.map((role) => <span key={role}>{role}</span>)
            )}
          </span>
        ),
      },
      {
        accessorKey: "version",
        header: "Version",
      },
      {
        id: "internal_ip",
        header: "Internal IP",
        cell: ({ row }) => {
          const address = row.original.status.addresses.find(
            (a) => a.type === "InternalIP"
          );
          return (
            <CopyableAddress
              value={address?.address}
              label="Internal IP"
              fallback="-"
            />
          );
        },
      },
      {
        id: "cpu",
        header: "CPU Usage",
        cell: ({ row }) => {
          const metrics = nodeMetricsByName.get(row.original.name);
          const capacity = row.original.capacity
            ? row.original.capacity.cpu
            : null;
          return (
            <MetricValue
              used={metrics?.cpuMillicores ?? null}
              limit={capacity ? parseCPU(capacity) : null}
              type="cpu"
            />
          );
        },
      },
      {
        id: "memory",
        header: "Memory Usage",
        cell: ({ row }) => {
          const metrics = nodeMetricsByName.get(row.original.name);
          const capacity = row.original.capacity
            ? row.original.capacity.memory
            : null;
          return (
            <MetricValue
              used={metrics?.memoryBytes ?? null}
              limit={capacity ? parseMemory(capacity) : null}
              type="memory"
            />
          );
        },
      },
      {
        id: "capacity_pods",
        header: "Pod Cap",
        cell: ({ row }) => row.original.capacity?.pods || "-",
      },
      {
        id: "age",
        header: "Age",
        cell: ({ row }) => <RealtimeAge timestamp={row.original.createdAt} />,
      },
    ],
    [nodeMetricsByName]
  );

  const quickActions = useMemo<QuickAction<NodeInfo>[]>(
    () => [
      {
        icon: Eye,
        label: "View Details",
        onClick: (item) =>
          navigate(getResourceDetailUrl(ResourceType.Node, item.name)),
      },
      {
        icon: ShieldOff,
        label: "Cordon",
        onClick: (item) => cordonMutation.mutate(item.name),
      },
      {
        icon: Shield,
        label: "Uncordon",
        onClick: (item) => uncordonMutation.mutate(item.name),
      },
      {
        icon: AlertTriangle,
        label: "Drain",
        // Straight to the dialog rather than to the mutation: a drain is the
        // one action here that can be refused by something the reader cannot
        // see from this row.
        onClick: (item) => setDraining(item.name),
        variant: "destructive",
      },
    ],
    [navigate, cordonMutation, uncordonMutation]
  );

  return (
    <>
      <ResourceList<NodeInfo>
        title="Nodes"
        queryKey={queryKeys.resources(ResourceType.Node, null)}
        getRowId={getResourceRowId}
        queryFn={() => commands.listNodes(null)}
        columns={columns}
        quickActions={quickActions}
        grouping={poolGrouping}
        emptyStateLabel={toPlural(ResourceType.Node)}
        staleTime={STALE_TIMES.resourceList}
        refetchInterval={watchFailed ? undefined : false}
        live={!watchFailed}
        headerContent={
          nodeStatus?.status !== "available" ? (
            <MetricsStatusBanner status={nodeStatus} />
          ) : null
        }
        getRowHref={(row) => getResourceDetailUrl(ResourceType.Node, row.name)}
      />
      <DrainDialog
        node={draining}
        onOpenChange={(open) => !open && setDraining(null)}
        busy={drainMutation.isPending}
        onConfirm={(node) => {
          setDraining(null);
          drainMutation.mutate(node);
        }}
      />
    </>
  );
}
