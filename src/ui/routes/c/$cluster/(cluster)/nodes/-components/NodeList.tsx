import { columnHeader } from "@/i18n/column-header";
import { T } from "@/i18n/T";
import { MetricsAbsenceContext, absenceOf } from "@/lib/metrics-absence";
import { useClusterStore } from "@/stores/clusterStore";
import { StatusBadge } from "@/components/ui/status-badge";
import { nodeReadyWord } from "@/lib/node-reporting";
import type { ColumnDef } from "@/components/ui/table-features";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { NodeUtilisation } from "./NodeUtilisation";
import type { UsageRange } from "@/integrations";
import { Eye, Shield, ShieldOff, AlertTriangle } from "lucide-react";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { QuickAction } from "@/components/ui/quick-actions";
import { hrefOf, objectLink } from "@/lib/links";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { MetricValue } from "@/components/ui/metric-value";
import { CopyableAddress, IPV4_CELL_PX } from "@/components/ui/copyable-value";
import { useCallback, useMemo } from "react";
import { commands } from "@/lib/commands";
import { whole } from "@/lib/namespace-scope";
import { useMetrics } from "@/hooks/useMetrics";
import { errorToShow } from "@/lib/error-utils";
import { formatUsage, notMeasured } from "@/lib/metric-format";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { MetricsStatusBanner } from "../../../-metrics";
import { ResourceList } from "../../../-list/ResourceList";
import { ResourceListHeader } from "../../../-list/ResourceListHeader";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { createAgeColumn, createNameColumn } from "../../../-list/columns";
import { SpotMark } from "../../../-object/spot-mark";
import type { RowGrouping } from "@/components/ui/row-grouping";
import { describePool, poolFacts, poolOf, spotMark } from "@/lib/node-pool";
import type { NodeInfo, NodeMetrics } from "@/generated/types";
import { STALE_TIMES } from "@/lib/refresh";
import { queryKeys } from "@/lib/query-keys";
import { getResourceRowId } from "@/lib/table-utils";
import { useWatchedList } from "@/hooks/useWatchedList";
import { useNodeActions } from "./useNodeActions";
import { useT, type T as TranslateFn } from "@/i18n/useT";
import { None } from "@/components/ui/none";

/**
 * Nodes, grouped by the pool the cloud says made them.
 *
 * On a managed cluster this is the difference between forty flat rows and
 * three pools of known machines in known places, half of them disposable. On
 * every other cluster `poolOf` returns null for every node, no group reaches
 * the minimum, and the page is exactly the flat list it always was.
 */
const poolGrouping = (t: TranslateFn): RowGrouping<NodeInfo> => ({
  keyOf: poolOf,
  caption: (pool, nodes) => {
    const facts = poolFacts(nodes);
    const spot = spotMark(facts, t);
    return (
      <span className="inline-flex items-baseline gap-2">
        <span className="font-mono text-fg-mid">{pool}</span>
        <span>{describePool(facts, t)}</span>
        {spot && <SpotMark says={spot} />}
      </span>
    );
  },
});

/** The copy label is a word, so the cell needs the hook the array cannot use. */
function InternalIpCell({ address }: { address: string | undefined }) {
  const t = useT();
  return <CopyableAddress value={address} label={t("columns", "internalIp")} />;
}

// Exported for `column-widths.test.ts`, at the cost of this file's fast
// refresh: a save remounts the page instead of hot-swapping it.
// oxlint-disable-next-line react-refresh/only-export-components
export const columns = (
  /** Keyed by node name; a node the metrics API missed gets an empty reading. */
  nodeMetricsByName: Map<string, NodeMetrics>
): ColumnDef<NodeInfo>[] => [
  createNameColumn<NodeInfo>(ResourceType.Node),
  {
    size: 110,
    id: "status",
    header: columnHeader("columns", "status"),
    meta: { share: (row: NodeInfo) => nodeReadyWord(row) },
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
    header: columnHeader("columns", "roles"),
    cell: ({ row }) => (
      <span className="flex flex-wrap items-baseline gap-x-2 text-fg-mut">
        {row.original.roles.length === 0 ? (
          <None />
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
    header: columnHeader("columns", "version"),
  },
  {
    size: 130,
    id: "internal_ip",
    header: columnHeader("columns", "internalIp"),
    meta: {
      floor: IPV4_CELL_PX,
      share: (row: NodeInfo, t) => ({
        text:
          row.status.addresses.find((a) => a.type === "InternalIP")?.address ??
          t("empty", "noneLower"),
        mono: true,
      }),
    },
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
    header: columnHeader("columns", "cpuUsage"),
    meta: {
      share: (row: NodeInfo, t) => {
        const used = nodeMetricsByName.get(row.name)?.cpuMillicores;
        return typeof used === "number"
          ? formatUsage(used, "cpu")
          : notMeasured(t);
      },
    },
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
    header: columnHeader("columns", "memoryUsage"),
    meta: {
      share: (row: NodeInfo, t) => {
        const used = nodeMetricsByName.get(row.name)?.memoryBytes;
        return typeof used === "number"
          ? formatUsage(used, "memory")
          : notMeasured(t);
      },
    },
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
    header: columnHeader("columns", "podCap"),
    meta: {
      share: (row: NodeInfo, t) =>
        row.capacity?.pods || {
          text: t("empty", "unknownLower"),
          quiet: true,
        },
    },
    cell: ({ row }) =>
      row.original.capacity?.pods || (
        <span className="text-fg-fnt">
          <T section="empty" k="unknownLower" />
        </span>
      ),
  },
  createAgeColumn<NodeInfo>(),
];

const NODES_TITLE = "Nodes";
const NODES_SCREEN = { title: NODES_TITLE, kind: ResourceType.Node };

const linkOf = (node: NodeInfo) =>
  objectLink({ kind: ResourceType.Node, name: node.name })!;

const NODE_DETAIL = queryKeys.rowDetail(ResourceType.Node);

export function NodeList() {
  const t = useT();
  const grouping = useMemo(() => poolGrouping(t), [t]);
  const { isConnected } = useClusterStore();
  const navigate = useNavigate();

  const queryKey = useMemo(
    () => queryKeys.resources(ResourceType.Node, null),
    []
  );
  const subscribeNodes = useCallback(() => commands.subscribeNodeWatch(), []);

  const { live, refresh, resyncing } = useWatchedList<NodeInfo>({
    enabled: isConnected,
    subscribe: subscribeNodes,
    queryKey,
    detail: NODE_DETAIL,
    reportFailure: toPlural(ResourceType.Node),
  });

  // In the URL, so a deep link can open the view and a reload keeps it.
  const search = useAppSearch();
  const setSearch = useSetSearch();
  const view = search.view === "utilisation" ? "utilisation" : "table";
  const range = (
    ["1h", "6h", "24h", "7d"].includes(search.range ?? "") ? search.range : "6h"
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
    setSearch(
      { view: next === "table" ? undefined : next },
      { replace: false }
    );
  const setRange = (next: UsageRange) =>
    setSearch({ range: next }, { replace: false });
  // The same key the table reads, so the switch costs no second list.
  const nodesForTrends = useQuery({
    queryKey,
    queryFn: () => commands.listNodes(null).then(whole),
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
        onClick: (item) => navigate(linkOf(item)),
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

  // The title row is ResourceList's own header in both views, fed the same
  // list and the same watch, so switching views changes only what is below it.
  if (view === "utilisation") {
    return (
      <>
        <div className="flex h-full min-h-0 flex-col gap-4 animate-in fade-in duration-200">
          <ResourceListHeader
            title={NODES_TITLE}
            count={nodesForTrends.data?.rows.length}
            actions={
              <>
                {viewToggle}
                <ShareScreenAction screen={NODES_SCREEN} />
              </>
            }
            dataUpdatedAt={nodesForTrends.dataUpdatedAt}
            live={live && !resyncing}
          />
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <NodeUtilisation
              nodes={nodesForTrends.data?.rows ?? []}
              nodesKnown={nodesForTrends.data !== undefined}
              nodesReason={
                nodesForTrends.error ? errorToShow(nodesForTrends.error) : null
              }
              range={range}
              onRange={setRange}
            />
          </div>
        </div>
        {actions.dialogs}
      </>
    );
  }

  return (
    <MetricsAbsenceContext.Provider value={absenceOf(nodeStatus)}>
      <ResourceList<NodeInfo>
        title={NODES_TITLE}
        queryKey={queryKeys.resources(ResourceType.Node, null)}
        getRowId={getResourceRowId}
        queryFn={() => commands.listNodes(null).then(whole)}
        columns={nodeColumns}
        quickActions={quickActions}
        grouping={grouping}
        emptyStateLabel={toPlural(ResourceType.Node)}
        staleTime={STALE_TIMES.resourceList}
        refresh={refresh}
        live={live}
        resyncing={resyncing}
        headerActions={viewToggle}
        headerContent={
          nodeStatus?.status !== "available" ? (
            <MetricsStatusBanner status={nodeStatus} />
          ) : null
        }
        getRowHref={(row) => hrefOf(linkOf(row))}
      />
      {actions.dialogs}
    </MetricsAbsenceContext.Provider>
  );
}
