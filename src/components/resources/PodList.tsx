import { ColumnDef } from "@tanstack/react-table";
import { T } from "@/i18n/T";
import { useNavigate } from "react-router-dom";
import { Eye, Trash2, Terminal, FileText } from "lucide-react";
import { useMemo } from "react";
import {
  usePodsWithMetrics,
  type PodWithMetrics,
} from "@/hooks/usePodsWithMetrics";
import { StatusBadge } from "@/components/ui/status-badge";
import { silenceNote, type WithNodeSilence } from "@/lib/node-reporting";
import { CopyableAddress } from "@/components/ui/copyable-value";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
} from "./columns";
import { podReadiness } from "@/lib/container-sequence";
import { commands } from "@/lib/commands";
import { ResourceList } from "./ResourceList";
import { ResourceRef } from "./ResourceRef";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { queryKeys } from "@/lib/query-keys";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { MetricsStatusBanner } from "@/components/metrics";
import { getResourceRowId } from "@/lib/table-utils";
import { formatAge } from "@/lib/utils";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useT } from "@/i18n/useT";

/** A pod row that also knows whether its node is still reporting. */
type PodRow = WithNodeSilence<PodWithMetrics>;

// Exported for `column-widths.test.ts`, at the cost of this file's fast
// refresh: a save remounts the page instead of hot-swapping it.
// eslint-disable-next-line react-refresh/only-export-components
export const columns: ColumnDef<PodRow>[] = [
  createNameColumn<PodRow>(ResourceType.Pod),
  createNamespaceColumn<PodRow>(),
  {
    // "CrashLoopBackOff" is the widest state this column ever shows, and it
    // is the one nobody should have to guess at from a truncation.
    size: 150,
    id: "status",
    header: () => <T section="columns" k="status" />,
    // The derived status, not the phase: a pod that has crashed 653
    // times is in phase `Running` and nobody means that by "how is
    // it". The phase rides along in the tooltip so it is not lost.
    cell: ({ row }) => {
      // A pod on a node that stopped reporting keeps whatever status the
      // kubelet last wrote. The label stays kubectl's — this is the status
      // the cluster holds — but the colour drops to neutral, because a
      // confident green about a machine nobody can reach is the lie.
      const silence = row.original.nodeSilence;
      return (
        <StatusBadge
          status={row.original.status.display}
          roleOverride={silence ? "neutral" : undefined}
          title={
            silence
              ? silenceNote(silence)
              : `Phase ${row.original.status.phase}`
          }
        />
      );
    },
  },
  createCpuColumn<PodRow>(),
  createMemoryColumn<PodRow>(),
  {
    size: 110,
    id: "ready",
    header: () => <T section="columns" k="ready" />,
    // The number people compare against `kubectl get pod` in the next
    // window, so it is kubectl's number: sidecars in both halves,
    // finished init containers in neither.
    cell: ({ row }) => {
      const { ready, total } = podReadiness(row.original);
      return (
        <span className="font-mono text-fg-mid">
          {ready}/{total}
        </span>
      );
    },
  },
  {
    // The count and the age of the last one: "653 (2h ago)".
    size: 130,
    id: "restarts",
    header: () => <T section="columns" k="restarts" />,
    // kubectl prints the count with the age of the last one, and it is
    // the half that carries the news: 653 an hour ago and 653 last
    // week are the same number and not the same pod.
    cell: ({ row }) => (
      <span
        className={
          row.original.restartCount > 5
            ? "font-mono text-warn"
            : "font-mono text-fg-mut"
        }
      >
        {row.original.restartCount}
        {row.original.restartCount > 0 && row.original.lastRestartAt && (
          <span className="text-fg-fnt">
            {" "}
            (
            <T
              section="action"
              k="agoSuffix"
              values={{ age: formatAge(row.original.lastRestartAt) }}
            />
            )
          </span>
        )}
      </span>
    ),
  },
  {
    // A managed node's name is as long as a pod's: `gke-prod-pool-1-a3f9-x2kd`.
    size: 220,
    id: "node",
    header: () => <T section="columns" k="node" />,
    cell: ({ row }) =>
      row.original.nodeName ? (
        <ResourceRef
          kind={ResourceType.Node}
          name={row.original.nodeName}
          showKind={false}
        />
      ) : (
        <span className="text-fg-fnt">-</span>
      ),
  },
  {
    size: 130,
    id: "ip",
    header: "IP",
    cell: ({ row }) => (
      <CopyableAddress
        value={row.original.podIp}
        label="Pod IP"
        fallback="-"
        className="text-fg-mut"
      />
    ),
  },
  createAgeColumn<PodRow>(),
];

export function PodList() {
  const t = useT();
  const navigate = useNavigate();
  const {
    data: podsWithMetrics,
    podStatus,
    isLoading,
    error,
    dataUpdatedAt,
    watchLive,
    resyncing,
  } = usePodsWithMetrics();

  const quickActions = useMemo<
    (
      setDeleteTarget: (item: PodWithMetrics) => void
    ) => QuickAction<PodWithMetrics>[]
  >(
    () => (setDeleteTarget) => [
      {
        icon: Eye,
        label: t("action", "viewDetails"),
        onClick: (item) =>
          navigate(
            getResourceDetailUrl(ResourceType.Pod, item.name, item.namespace)
          ),
      },
      {
        icon: FileText,
        label: t("action", "viewLogs"),
        onClick: (item) =>
          navigate(
            `${getResourceDetailUrl(ResourceType.Pod, item.name, item.namespace)}?tab=logs`
          ),
      },
      {
        icon: Terminal,
        label: t("action", "shell"),
        onClick: (item) =>
          navigate(
            `${getResourceDetailUrl(ResourceType.Pod, item.name, item.namespace)}?tab=terminal`
          ),
      },
      {
        icon: Trash2,
        label: t("action", "delete"),
        onClick: (item) => setDeleteTarget(item),
        variant: "destructive",
      },
    ],
    [t, navigate]
  );

  return (
    <ResourceList<PodWithMetrics>
      title="Pods"
      data={podsWithMetrics}
      isLoading={isLoading}
      error={error}
      dataUpdatedAt={dataUpdatedAt}
      live={watchLive}
      resyncing={resyncing}
      getRowId={getResourceRowId}
      columns={columns}
      quickActions={quickActions}
      emptyStateLabel={toPlural(ResourceType.Pod)}
      // Inside the list rather than above it, as the Nodes page has it: the
      // list owns the window's height now, and a banner outside it is one more
      // box the height has to be threaded through.
      headerContent={
        podStatus?.status !== "available" ? (
          <MetricsStatusBanner status={podStatus} />
        ) : null
      }
      getRowHref={(row) =>
        getResourceDetailUrl(ResourceType.Pod, row.name, row.namespace)
      }
      deleteConfig={{
        mutationFn: (item) =>
          commands.deletePod(item.name, item.namespace, false),
        invalidateQueryKeys: [queryKeys.pods()],
        resourceType: ResourceType.Pod,
      }}
    />
  );
}
