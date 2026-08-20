import { useMutation, useQueryClient } from "@tanstack/react-query";
import { T } from "@/i18n/T";
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
import type { NodeInfo, NodeMetrics } from "@/generated/types";
import { STALE_TIMES } from "@/lib/refresh";
import { queryKeys } from "@/lib/query-keys";
import { RealtimeAge } from "@/components/ui/realtime";
import { getResourceRowId } from "@/lib/table-utils";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { DrainDialog } from "@/components/resources/drain-dialog";
import { useT } from "@/i18n/useT";

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

/** The copy label is a word, so the cell needs the hook the array cannot use. */
function InternalIpCell({ address }: { address: string | undefined }) {
  const t = useT();
  return (
    <CopyableAddress
      value={address}
      label={t("columns", "internalIp")}
      fallback="-"
    />
  );
}

// Exported for `column-widths.test.ts`, at the cost of this file's fast
// refresh: a save remounts the page instead of hot-swapping it.
// eslint-disable-next-line react-refresh/only-export-components
export const columns = (
  /** Keyed by node name; a node the metrics API missed gets an empty reading. */
  nodeMetricsByName: Map<string, NodeMetrics>
): ColumnDef<NodeInfo>[] => [
  createNameColumn<NodeInfo>(ResourceType.Node),
  {
    size: 110,
    id: "status",
    header: () => <T section="columns" k="status" />,
    cell: ({ row }) => {
      const ready = row.original.status.ready;
      return <StatusBadge status={ready ? "Ready" : "NotReady"} />;
    },
  },
  {
    // "control-plane master etcd" on a single-node cluster.
    size: 170,
    accessorKey: "roles",
    header: () => <T section="columns" k="roles" />,
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
    // A kubelet version with its distro suffix: `v1.31.4+k3s1`.
    size: 120,
    accessorKey: "version",
    header: () => <T section="columns" k="version" />,
  },
  {
    size: 130,
    id: "internal_ip",
    header: () => <T section="columns" k="internalIp" />,
    cell: ({ row }) => {
      const address = row.original.status.addresses.find(
        (a) => a.type === "InternalIP"
      );
      return <InternalIpCell address={address?.address} />;
    },
  },
  // Wider than the pod table's CPU and Memory: these carry a usage bar
  // against the node's whole capacity, under a two-word header.
  {
    size: 120,
    id: "cpu",
    header: () => <T section="columns" k="cpuUsage" />,
    cell: ({ row }) => {
      const metrics = nodeMetricsByName.get(row.original.name);
      const capacity = row.original.capacity ? row.original.capacity.cpu : null;
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
    size: 140,
    id: "memory",
    header: () => <T section="columns" k="memoryUsage" />,
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
    size: 120,
    id: "capacity_pods",
    header: () => <T section="columns" k="podCap" />,
    cell: ({ row }) => row.original.capacity?.pods || "-",
  },
  {
    size: 80,
    id: "age",
    header: () => <T section="columns" k="age" />,
    cell: ({ row }) => <RealtimeAge timestamp={row.original.createdAt} />,
  },
];

export function NodeList() {
  const t = useT();
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
        title: t("action", "realtimeUnavailable"),
        description: t("action", "realtimeFallback", {
          kind: toPlural(ResourceType.Node),
          error: err,
        }),
      });
    },
    [t, toast, watchFailed]
  );
  const { resyncing } = useResourceWatch<NodeInfo>({
    enabled: isConnected,
    subscribe: subscribeNodes,
    queryKey,
    onError: handleWatchError,
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });

  const { nodeMetrics, nodeStatus } = useMetrics({
    includePods: false,
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
        title: t("action", "nodeCordoned"),
        description: t("action", "nodeCordonedDetail", { name: nodeName }),
      });
    },
    onError: (error) => {
      toast({
        title: t("action", "error"),
        description: t("action", "cordonFailed", { error: String(error) }),
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
        title: t("action", "nodeUncordoned"),
        description: t("action", "nodeUncordonedDetail", { name: nodeName }),
      });
    },
    onError: (error) => {
      toast({
        title: t("action", "error"),
        description: t("action", "uncordonFailed", { error: String(error) }),
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
        title: t("action", "nodeDrained"),
        description: t("action", "nodeDrainedDetail", { name: nodeName }),
      });
    },
    onError: (error) => {
      toast({
        title: t("action", "error"),
        description: t("action", "drainFailed", { error: String(error) }),
        variant: "destructive",
      });
    },
  });

  const [draining, setDraining] = useState<string | null>(null);

  const nodeColumns = useMemo(
    () => columns(nodeMetricsByName),
    [nodeMetricsByName]
  );

  const quickActions = useMemo<QuickAction<NodeInfo>[]>(
    () => [
      {
        icon: Eye,
        label: t("action", "viewDetails"),
        onClick: (item) =>
          navigate(getResourceDetailUrl(ResourceType.Node, item.name)),
      },
      {
        icon: ShieldOff,
        label: t("action", "cordon"),
        onClick: (item) => cordonMutation.mutate(item.name),
      },
      {
        icon: Shield,
        label: t("action", "uncordon"),
        onClick: (item) => uncordonMutation.mutate(item.name),
      },
      {
        icon: AlertTriangle,
        label: t("action", "drain"),
        // Straight to the dialog rather than to the mutation: a drain is the
        // one action here that can be refused by something the reader cannot
        // see from this row.
        onClick: (item) => setDraining(item.name),
        variant: "destructive",
      },
    ],
    [t, navigate, cordonMutation, uncordonMutation]
  );

  return (
    <>
      <ResourceList<NodeInfo>
        title="Nodes"
        queryKey={queryKeys.resources(ResourceType.Node, null)}
        getRowId={getResourceRowId}
        queryFn={() => commands.listNodes(null)}
        columns={nodeColumns}
        quickActions={quickActions}
        grouping={poolGrouping}
        emptyStateLabel={toPlural(ResourceType.Node)}
        staleTime={STALE_TIMES.resourceList}
        refresh={watchFailed ? undefined : false}
        live={!watchFailed}
        resyncing={resyncing}
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
