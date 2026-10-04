import type { ColumnDef } from "@/components/ui/table-features";
import { T } from "@/i18n/T";
import { columnHeader } from "@/i18n/column-header";
import { SortableHeader } from "@/components/ui/sortable-header";
import { useNavigate } from "@tanstack/react-router";
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
} from "../../../-list/columns";
import { podReadiness } from "@/lib/container-sequence";
import { commands } from "@/lib/commands";
import { ResourceList } from "../../../-list/ResourceList";
import { ResourceRef } from "@/components/object/ResourceRef";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { queryKeys } from "@/lib/query-keys";
import { hrefOf, objectLink } from "@/lib/links";
import { MetricsStatusBanner } from "../../../-metrics";
import { getResourceRowId } from "@/lib/table-utils";
import { formatAge } from "@/lib/utils";
import { refOf } from "@/lib/report-parts";
import { podStatusValue } from "@/lib/share/pod-status";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useT } from "@/i18n/useT";

/** A pod row that also knows whether its node is still reporting. */
type PodRow = WithNodeSilence<PodWithMetrics>;

/**
 * How long ago the last restart was.
 *
 * A component rather than an expression in the column literal: the age now
 * needs the translator, and a hook is only legal inside one.
 */
function RestartAge({ at }: { at: string }) {
  const t = useT();
  return (
    <T section="action" k="agoSuffix" values={{ age: formatAge(at, t) }} />
  );
}

/**
 * A pod on a node that stopped reporting keeps whatever the kubelet last
 * wrote. The label stays kubectl's — this is what the cluster holds — but
 * the colour drops to neutral, because confident green about a machine
 * nobody can reach is a lie.
 */
function PodStatusCell({ pod }: { pod: PodRow }) {
  const t = useT();
  const silence = pod.nodeSilence;
  return (
    <StatusBadge
      status={pod.status.display}
      roleOverride={silence ? "neutral" : undefined}
      title={
        silence
          ? silenceNote(silence, t)
          : t("readings", "podPhase", { phase: pod.status.phase })
      }
    />
  );
}

/** The copy label is a word, so the cell needs the hook the array cannot use. */
function PodIpCell({ pod }: { pod: PodRow }) {
  const t = useT();
  return (
    <CopyableAddress
      value={pod.podIp}
      label={t("columns", "podIp")}
      fallback="-"
      className="text-fg-mut"
    />
  );
}

// Exported for `column-widths.test.ts`, at the cost of this file's fast
// refresh: a save remounts the page instead of hot-swapping it.
// oxlint-disable-next-line react-refresh/only-export-components
export const columns: ColumnDef<PodRow>[] = [
  createNameColumn<PodRow>(ResourceType.Pod),
  createNamespaceColumn<PodRow>(),
  {
    // "CrashLoopBackOff" is the widest state this column ever shows, and it
    // is the one nobody should have to guess at from a truncation.
    size: 150,
    id: "status",
    // Sorted by the word the reader sees, not by the phase behind it: they
    // asked for this to group the crashing pods together, and `Running` is
    // the phase of a pod that has crashed six hundred times.
    accessorFn: (pod) => pod.status.display,
    enableSorting: true,
    meta: {
      label: { section: "columns", key: "status" },
      share: (pod: PodRow, t) =>
        podStatusValue(pod, pod.nodeSilence ?? null, t),
    },
    header: ({ column }) => (
      <SortableHeader column={column}>
        <T section="columns" k="status" />
      </SortableHeader>
    ),
    // The derived status, not the phase: a pod that has crashed 653
    // times is in phase `Running` and nobody means that by "how is
    // it". The phase rides along in the tooltip so it is not lost.
    cell: ({ row }) => <PodStatusCell pod={row.original} />,
  },
  createCpuColumn<PodRow>(),
  createMemoryColumn<PodRow>(),
  {
    size: 110,
    id: "ready",
    // By what is missing, so the ones short of a replica sort together —
    // 0/3 before 2/3 before 1/1.
    accessorFn: (pod) => {
      const { ready, total } = podReadiness(pod);
      return total - ready;
    },
    enableSorting: true,
    meta: {
      label: { section: "columns", key: "ready" },
      share: (pod: PodRow) => {
        const { ready, total } = podReadiness(pod);
        return { text: `${ready}/${total}`, mono: true };
      },
    },
    header: ({ column }) => (
      <SortableHeader column={column}>
        <T section="columns" k="ready" />
      </SortableHeader>
    ),
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
    accessorFn: (pod) => pod.restartCount,
    enableSorting: true,
    meta: {
      label: { section: "columns", key: "restarts" },
      share: (pod: PodRow) => ({
        text: String(pod.restartCount),
        mono: true,
        role: pod.restartCount > 5 ? "warn" : undefined,
      }),
    },
    header: ({ column }) => (
      <SortableHeader column={column}>
        <T section="columns" k="restarts" />
      </SortableHeader>
    ),
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
            <RestartAge at={row.original.lastRestartAt} />)
          </span>
        )}
      </span>
    ),
  },
  {
    // A managed node's name is as long as a pod's: `gke-prod-pool-1-a3f9-x2kd`.
    size: 220,
    id: "node",
    header: columnHeader("columns", "node"),
    meta: {
      share: (pod: PodRow) =>
        pod.nodeName
          ? {
              text: pod.nodeName,
              ref: refOf({ kind: "Node", name: pod.nodeName, namespace: null }),
            }
          : "-",
    },
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
    header: columnHeader("columns", "ip"),
    meta: { share: (pod: PodRow) => ({ text: pod.podIp ?? "-", mono: true }) },
    cell: ({ row }) => <PodIpCell pod={row.original} />,
  },
  createAgeColumn<PodRow>(),
];

export function PodList() {
  const t = useT();
  const navigate = useNavigate();
  const {
    data: podsWithMetrics,
    podStatus,
    podUnread,
    refetchPodMetrics,
    isLoading,
    error,
    unread,
    isPlaceholderData,
    dataUpdatedAt,
    watchLive,
    resyncing,
    waitingSince,
    refetch,
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
          navigate(objectLink({ kind: ResourceType.Pod, ...item })!),
      },
      {
        icon: FileText,
        label: t("action", "viewLogs"),
        onClick: (item) =>
          navigate(
            objectLink({ kind: ResourceType.Pod, ...item }, { tab: "logs" })!
          ),
      },
      {
        icon: Terminal,
        label: t("action", "shell"),
        onClick: (item) =>
          navigate(
            objectLink({ kind: ResourceType.Pod, ...item }, { tab: "shell" })!
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
      unread={unread}
      placeholder={isPlaceholderData}
      isLoading={isLoading}
      waitingSince={waitingSince}
      onRetry={() => void refetch()}
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
        <MetricsStatusBanner
          status={podStatus}
          unread={podUnread}
          onRetry={() => void refetchPodMetrics()}
        />
      }
      getRowHref={(row) =>
        hrefOf(objectLink({ kind: ResourceType.Pod, ...row })!)
      }
      deleteConfig={{
        mutationFn: (item) =>
          commands.deletePod(item.name, item.namespace, false),
        invalidateQueryKeys: [queryKeys.everyPodRows()],
        resourceType: ResourceType.Pod,
      }}
    />
  );
}
