import type { ColumnDef } from "@/components/ui/table-features";
import { T } from "@/i18n/T";
import { columnHeader } from "@/i18n/column-header";

import type { PersistentVolumeInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { whole } from "@/lib/namespace-scope";
import { ResourceType } from "@/lib/resource-registry";
import { PhaseBadge } from "@/components/ui/status-badge";
import { ClaimRef, StorageClassRef } from "../../../-object/storage-refs";
import {
  createAccessModesColumn,
  createCapacityColumn,
  createAgeColumn,
  createNameColumn,
} from "../../../-list/columns";
import { createResourceListPage } from "../../../-list/createResourceListPage";

export const columns = (): ColumnDef<PersistentVolumeInfo>[] => [
  createNameColumn<PersistentVolumeInfo>(ResourceType.PersistentVolume),
  createCapacityColumn<PersistentVolumeInfo>(),
  createAccessModesColumn<PersistentVolumeInfo>(),
  {
    // "Retain" or "Delete" under a two-word header.
    size: 120,
    accessorKey: "reclaimPolicy",
    header: columnHeader("columns", "reclaimPolicy"),
    cell: ({ row }) => (
      <span
        className={row.original.reclaimPolicy ? "text-fg-mid" : "text-fg-mut"}
      >
        {row.original.reclaimPolicy ?? (
          <T section="empty" k="nothingReportedYet" />
        )}
      </span>
    ),
  },
  {
    size: 110,
    accessorKey: "status",
    header: columnHeader("columns", "status"),
    cell: ({ row }) => <PhaseBadge phase={row.original.status} />,
  },
  {
    // A namespace and a claim name together, so as wide as a name column.
    size: 240,
    accessorKey: "claim",
    header: columnHeader("columns", "claim"),
    cell: ({ row }) => <ClaimRef claim={row.original.claim} />,
  },
  {
    size: 160,
    accessorKey: "storageClass",
    header: columnHeader("columns", "storageClass"),
    cell: ({ row }) => <StorageClassRef name={row.original.storageClass} />,
  },
  createAgeColumn<PersistentVolumeInfo>(),
];

export const PersistentVolumeList =
  createResourceListPage<PersistentVolumeInfo>({
    resourceType: ResourceType.PersistentVolume,
    title: "Persistent Volumes",
    description: ({ t }) => t("empty", "persistentVolumesAre"),
    scope: "cluster",
    fetcher: () => commands.listPersistentVolumes(null).then(whole),
    watch: () => commands.subscribePersistentvolumeWatch(),
    deleter: (item) => commands.deletePersistentVolume(item.name),
    columns,
  });
