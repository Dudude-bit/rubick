import { T } from "@/i18n/T";
import { useClusterStore } from "@/stores/clusterStore";
import { StatusBadge } from "@/components/ui/status-badge";
import { nodeReadyWord } from "@/lib/node-reporting";
import type { ColumnDef } from "@/components/ui/table-features";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { NodeUtilisation } from "@/components/resources/NodeUtilisation";
import type { UsageRange } from "@/integrations";
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
import { normalizeTauriError } from "@/lib/error-utils";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { MetricsStatusBanner } from "@/components/metrics";
import { ResourceList } from "@/components/resources/ResourceList";
import {
  createAgeColumn,
  createNameColumn,
} from "@/components/resources/columns";
import { SpotMark } from "@/components/resources/spot-mark";
import type { RowGrouping } from "@/components/ui/row-grouping";
import { describePool, poolFacts, poolOf, spotMark } from "@/lib/node-pool";
import type { NodeInfo, NodeMetrics } from "@/generated/types";
import { STALE_TIMES } from "@/lib/refresh";
import { queryKeys } from "@/lib/query-keys";
import { getResourceRowId } from "@/lib/table-utils";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useNodeActions } from "@/hooks/useNodeActions";
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
      // A cordoned node keeps `Ready: True`, so judging it by conditions
      // alone called it healthy full stop — the overview said "Cordoned"
      // about the same node. The word is `kubectl`'s and is composed in one
      // place, because this was three readers and only one of them knew.
      return <StatusBadge status={nodeReadyWord(row.original)} />;
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
  createAgeColumn<NodeInfo>(),
];

export function NodeList() {
  const t = useT();
  const { isConnected } = useClusterStore();
  const { toast } = useToast();
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

  // In the URL, so a deep link can open the view and a reload keeps it.
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "utilisation" ? "utilisation" : "table";
  const range = (
    ["1h", "6h", "24h", "7d"].includes(params.get("range") ?? "")
      ? params.get("range")
      : "6h"
  ) as UsageRange;

  // Not while the Utilisation view is up: nothing there reads a live
  // metrics-server figure, and this polls every two seconds.
  const { nodeMetrics, nodeStatus } = useMetrics({
    includePods: false,
    enabled: isConnected && view === "table",
  });

  const nodeMetricsByName = useMemo(() => {
    const metricsMap = new Map<string, (typeof nodeMetrics)[number]>();
    for (const metric of nodeMetrics) {
      metricsMap.set(metric.name, metric);
    }
    return metricsMap;
  }, [nodeMetrics]);

  const actions = useNodeActions();

  const setView = (next: "table" | "utilisation") =>
    setParams((current) => {
      const out = new URLSearchParams(current);
      if (next === "table") out.delete("view");
      else out.set("view", next);
      return out;
    });
  const setRange = (next: UsageRange) =>
    setParams((current) => {
      const out = new URLSearchParams(current);
      out.set("range", next);
      return out;
    });
  // The same key the table reads, so the switch costs no second list.
  const nodesForTrends = useQuery({
    queryKey,
    queryFn: () => commands.listNodes(null),
    enabled: isConnected && view === "utilisation",
    staleTime: STALE_TIMES.resourceList,
  });

  const viewToggle = (
    <span
      role="tablist"
      aria-label={t("columns", "view")}
      className="flex items-center gap-0.5"
    >
      {(["table", "utilisation"] as const).map((candidate) => (
        <button
          key={candidate}
          type="button"
          role="tab"
          aria-selected={view === candidate}
          onClick={() => setView(candidate)}
          className={
            view === candidate
              ? "rounded bg-sel px-1.5 py-0.5 text-[11px] text-fg"
              : "rounded px-1.5 py-0.5 text-[11px] text-fg-mut hover:bg-hover hover:text-fg"
          }
        >
          {t("columns", candidate === "table" ? "tableView" : "utilisation")}
        </button>
      ))}
    </span>
  );

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
        onClick: (item) => actions.cordon(item.name),
      },
      {
        icon: Shield,
        label: t("action", "uncordon"),
        onClick: (item) => actions.uncordon(item.name),
      },
      {
        icon: AlertTriangle,
        label: t("action", "drain"),
        // Straight to the dialog rather than to a mutation: a drain is the
        // one action here that can be refused by something the reader cannot
        // see from this row.
        onClick: (item) => actions.drain(item.name),
        variant: "destructive",
      },
    ],
    [t, navigate, actions]
  );

  if (view === "utilisation") {
    return (
      <>
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-[13px] font-semibold tracking-tight text-fg">
            Nodes
          </h1>
          {viewToggle}
        </div>
        <NodeUtilisation
          nodes={nodesForTrends.data ?? []}
          nodesKnown={nodesForTrends.data !== undefined}
          nodesReason={
            nodesForTrends.error
              ? normalizeTauriError(nodesForTrends.error)
              : null
          }
          range={range}
          onRange={setRange}
        />
        {actions.dialogs}
      </>
    );
  }

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
          <>
            <div className="mb-2 flex justify-end">{viewToggle}</div>
            {nodeStatus?.status !== "available" ? (
              <MetricsStatusBanner status={nodeStatus} />
            ) : null}
          </>
        }
        getRowHref={(row) => getResourceDetailUrl(ResourceType.Node, row.name)}
      />
      {actions.dialogs}
    </>
  );
}
