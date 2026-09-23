import { createContext, useCallback, useContext, useMemo } from "react";
import { T } from "@/i18n/T";
import type { CellContext, ColumnDef } from "@/components/ui/table-features";
import { Crosshair } from "lucide-react";

import { ResourceList } from "./ResourceList";
import { ResourceRef } from "./ResourceRef";
import { StatusBadge } from "@/components/ui/status-badge";
import { createAgeColumn } from "./columns";
import { useClusterSummary } from "@/hooks/useClusterSummary";
import { useWatchedList } from "@/hooks/useWatchedList";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { getResourceRowId } from "@/lib/table-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type { QuickAction } from "@/components/ui/quick-actions";
import type { NamespaceInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

const NamespaceCells = createContext({
  currentNamespace: "",
  // `null`/absent = the cluster-wide overview did not answer, so the count is
  // unknown and drawn "—" — never silently 0.
  podCounts: new Map<string, number | null>(),
});

function NameCell({ row }: CellContext<NamespaceInfo>) {
  const { currentNamespace } = useContext(NamespaceCells);
  return (
    <span className="flex items-baseline gap-2">
      <ResourceRef
        kind={ResourceType.Namespace}
        name={row.original.name}
        showKind={false}
      />
      {row.original.name === currentNamespace && (
        <span className="text-[11px] text-fg-fnt">
          <T section="cluster" k="currentScope" />
        </span>
      )}
    </span>
  );
}

function PodsCell({ row }: CellContext<NamespaceInfo>) {
  const { podCounts } = useContext(NamespaceCells);
  const count = podCounts.get(row.original.name);
  return (
    <span className="font-mono text-fg-mut">{count == null ? "—" : count}</span>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const columns: ColumnDef<NamespaceInfo>[] = [
  {
    size: 420,
    accessorKey: "name",
    header: () => <T section="columns" k="name" />,
    cell: NameCell,
  },
  {
    size: 120,
    accessorKey: "status",
    header: () => <T section="columns" k="status" />,
    cell: ({ row }) => <StatusBadge status={row.original.status} showDot />,
  },
  {
    size: 80,
    id: "pods",
    header: () => <T section="columns" k="pods" />,
    cell: PodsCell,
  },
  createAgeColumn<NamespaceInfo>(),
];

/**
 * Namespaces have no detail page and no delete action here — deleting one
 * takes everything inside it with it, which is not a hover-target decision.
 * The row's useful verb is "point this window at it", so that is the action.
 */
export function NamespaceList() {
  const t = useT();
  const switchNamespace = useClusterStore((s) => s.switchNamespace);
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const isConnected = useClusterStore((s) => s.isConnected);
  const { namespaces } = useClusterSummary();

  // This page polled while every other cluster-scoped list watched, and the
  // command it needed had been written and never called. A namespace is
  // created and deleted rarely enough that the poll was never obviously
  // wrong, and often enough — a `kubectl apply` of somebody's whole stack —
  // that the delay was noticed and blamed on the cluster.
  const queryKey = useMemo(
    () => queryKeys.resources(ResourceType.Namespace, null),
    []
  );
  const subscribeNamespaces = useCallback(
    () => commands.subscribeNamespaceWatch(),
    []
  );

  const { live, refresh, resyncing } = useWatchedList<NamespaceInfo>({
    enabled: isConnected,
    subscribe: subscribeNamespaces,
    queryKey,
    reportFailure: toPlural(ResourceType.Namespace),
  });

  const podCounts = useMemo(
    () => new Map(namespaces.map((ns) => [ns.name, ns.podCount])),
    [namespaces]
  );

  const cellContext = useMemo(
    () => ({ currentNamespace, podCounts }),
    [currentNamespace, podCounts]
  );

  // Held still like every other page's, so a watch tick does not rebuild the
  // table's column model under the pointer.
  const quickActions = useMemo<QuickAction<NamespaceInfo>[]>(
    () => [
      {
        icon: Crosshair,
        label: t("action", "scopeWindowToIt"),
        onClick: (item) => switchNamespace(item.name),
      },
    ],
    [switchNamespace, t]
  );

  return (
    <NamespaceCells.Provider value={cellContext}>
      <ResourceList<NamespaceInfo>
        title="Namespaces"
        queryKey={queryKey}
        queryFn={() => commands.listNamespaces()}
        staleTime={STALE_TIMES.slow}
        refresh={refresh}
        live={live}
        resyncing={resyncing}
        getRowId={getResourceRowId}
        columns={columns}
        emptyStateLabel="Namespaces"
        quickActions={quickActions}
      />
    </NamespaceCells.Provider>
  );
}
