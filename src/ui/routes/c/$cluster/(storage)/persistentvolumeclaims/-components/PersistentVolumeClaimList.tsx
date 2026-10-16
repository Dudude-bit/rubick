import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { columnHeader } from "@/i18n/column-header";
import { useNavigate } from "@tanstack/react-router";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { scopeCacheKey } from "@/lib/namespace-scope";
import type { ColumnDef } from "@/components/ui/table-features";
import { Eye, Trash2 } from "lucide-react";
import { ResourceList } from "../../../-list/ResourceList";
import {
  ClaimClassCell,
  ClaimStatusCell,
  ClaimVolumeCell,
} from "../../../-object/ClaimStatus";
import {
  createAccessModesColumn,
  createCapacityColumn,
  createAgeColumn,
  createNameColumn,
  createNamespaceColumn,
  causeTextPx,
  refCellPx,
  statusCellPx,
  yielding,
} from "../../../-list/columns";
import type { QuickAction } from "@/components/ui/quick-actions";
import { commands } from "@/lib/commands";
import type { PersistentVolumeClaimInfo, Scoped } from "@/generated/types";
import { useClaimReads } from "@/hooks/useStorageClasses";
import type { T as Translate } from "@/i18n/useT";
import {
  claimCause,
  claimCauseText,
  claimNeeds,
  type ClaimReads,
} from "@/lib/claim-cause";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { hrefOf, objectLink } from "@/lib/links";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { getResourceRowId } from "@/lib/table-utils";
import { useWatchedList } from "@/hooks/useWatchedList";
import { useT } from "@/i18n/useT";

/** `Pending`, the widest phase a claim has, as its badge draws it. */
const STATUS_PX = statusCellPx(7);

/** Enough of a generated `pvc-3f2c1e0a-…` to tell two apart; the rest is on hover. */
const VOLUME_GLYPHS = 12;
/** `standard-rwo` and `k8s-gui-hostpath` whole. */
const CLASS_GLYPHS = 16;

/** The words each row says after its badge, for the column's width and the shared file. */
const causesSaid = (
  rows: readonly PersistentVolumeClaimInfo[],
  reads: ClaimReads,
  t: Translate
) =>
  rows.flatMap((row) => {
    const cause = claimCause(row, reads);
    return cause ? [claimCauseText(cause, t)] : [];
  });

// Exported for `column-widths.test.ts`, at the cost of this file's fast
// refresh: a save remounts the page instead of hot-swapping it.
// oxlint-disable-next-line react-refresh/only-export-components
export const columns = (
  reads: ClaimReads
): ColumnDef<PersistentVolumeClaimInfo>[] => [
  createNameColumn<PersistentVolumeClaimInfo>(
    ResourceType.PersistentVolumeClaim
  ),
  createNamespaceColumn<PersistentVolumeClaimInfo>(),
  {
    size: 110,
    accessorKey: "status",
    header: columnHeader("columns", "status"),
    meta: {
      floor: STATUS_PX,
      ideal: (t, rows: readonly PersistentVolumeClaimInfo[]) =>
        STATUS_PX + causeTextPx(causesSaid(rows, reads, t)),
      share: (row: PersistentVolumeClaimInfo, t) => {
        const [said] = causesSaid([row], reads, t);
        return said ? `${row.status} · ${said}` : row.status;
      },
    },
    cell: ({ row }) => <ClaimStatusCell claim={row.original} reads={reads} />,
  },
  {
    // A generated PV name — `pvc-3f2c1e0a-…` — is as long as the claim's own.
    size: 300,
    accessorKey: "volume",
    header: columnHeader("columns", "volume"),
    meta: {
      floor: (_t, rows: readonly PersistentVolumeClaimInfo[]) =>
        refCellPx(rows, (row) => row.volume, VOLUME_GLYPHS),
    },
    cell: ({ row }) => <ClaimVolumeCell claim={row.original} reads={reads} />,
  },
  createCapacityColumn<PersistentVolumeClaimInfo>(),
  yielding(createAccessModesColumn<PersistentVolumeClaimInfo>(), 1),
  {
    size: 160,
    accessorKey: "storageClass",
    header: columnHeader("columns", "storageClass"),
    cell: ({ row }) => <ClaimClassCell claim={row.original} reads={reads} />,
    meta: {
      yields: 2,
      floor: (_t, rows: readonly PersistentVolumeClaimInfo[]) =>
        refCellPx(rows, (row) => row.storageClass || "default", CLASS_GLYPHS),
    },
  },
  yielding(createAgeColumn<PersistentVolumeClaimInfo>(), 3),
];

const pvcLink = (pvc: PersistentVolumeClaimInfo) =>
  objectLink({
    kind: ResourceType.PersistentVolumeClaim,
    name: pvc.name,
    namespace: pvc.namespace,
  })!;

const PVC_DETAIL = queryKeys.rowDetail(ResourceType.PersistentVolumeClaim);
const NEEDS_NOTHING = claimNeeds([]);

export function PersistentVolumeClaimList() {
  const t = useT();
  const scope = useNamespaceScope();
  const navigate = useNavigate();

  const cacheKey = scopeCacheKey(scope.scope);

  const queryKey = useMemo(
    () => queryKeys.resources(ResourceType.PersistentVolumeClaim, cacheKey),
    [cacheKey]
  );
  const subscribe = useCallback(
    () => commands.subscribePvcWatch(scope.wire),
    [scope.wire]
  );

  const { live, refresh, resyncing } =
    useWatchedList<PersistentVolumeClaimInfo>({
      enabled: true,
      subscribe,
      queryKey,
      detail: PVC_DETAIL,
      reportFailure: toPlural(ResourceType.PersistentVolumeClaim),
    });
  const queryFn = () => commands.listPersistentVolumeClaimsIn(scope.wire);
  // Following the list the table reads, not asking it: what explains a
  // Pending claim is read only while some claim is.
  const { data: needs = NEEDS_NOTHING } = useQuery({
    queryKey,
    queryFn,
    enabled: false,
    select: (claims: Scoped<PersistentVolumeClaimInfo>) =>
      claimNeeds(claims.rows),
  });
  const reads = useClaimReads(needs);
  const claimColumns = useMemo(() => columns(reads), [reads]);

  const quickActions = useMemo<
    (
      setDeleteTarget: (item: PersistentVolumeClaimInfo) => void
    ) => QuickAction<PersistentVolumeClaimInfo>[]
  >(
    () => (setDeleteTarget) => [
      {
        icon: Eye,
        label: t("action", "viewDetails"),
        onClick: (item) => navigate(pvcLink(item)),
      },
      {
        icon: Trash2,
        label: t("action", "delete"),
        onClick: (item) => setDeleteTarget(item),
        variant: "destructive",
      },
    ],
    [navigate, t]
  );

  return (
    <ResourceList<PersistentVolumeClaimInfo>
      title="Persistent Volume Claims"
      queryKey={queryKey}
      getRowId={getResourceRowId}
      queryFn={queryFn}
      columns={claimColumns}
      quickActions={quickActions}
      emptyStateLabel={toPlural(ResourceType.PersistentVolumeClaim)}
      deleteConfig={{
        mutationFn: (item) =>
          commands.deletePersistentVolumeClaim(
            item.name,
            item.namespace ?? null
          ),
        invalidateQueryKeys: [queryKey],
        resourceType: ResourceType.PersistentVolumeClaim,
      }}
      staleTime={STALE_TIMES.resourceList}
      refresh={refresh}
      live={live}
      resyncing={resyncing}
      getRowHref={(row) => hrefOf(pvcLink(row))}
    />
  );
}
