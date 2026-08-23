import type { ColumnDef } from "@tanstack/react-table";
import { T } from "@/i18n/T";

import type { PersistentVolumeInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { StatusBadge } from "@/components/ui/status-badge";
import { ClaimRef, StorageClassRef } from "./storage-refs";
import {
  createAccessModesColumn,
  createCapacityColumn,
  createNameColumn,
} from "./columns";
import { createResourceListPage } from "./createResourceListPage";

export const columns = (): ColumnDef<PersistentVolumeInfo>[] => [
  createNameColumn<PersistentVolumeInfo>(ResourceType.PersistentVolume),
  createCapacityColumn<PersistentVolumeInfo>(),
  createAccessModesColumn<PersistentVolumeInfo>(),
  {
    // "Retain" or "Delete" under a two-word header.
    size: 120,
    accessorKey: "reclaimPolicy",
    header: () => <T section="columns" k="reclaimPolicy" />,
    cell: ({ row }) => (
      <span className="text-fg-mid">{row.original.reclaimPolicy}</span>
    ),
  },
  {
    size: 110,
    accessorKey: "status",
    header: () => <T section="columns" k="status" />,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    // A namespace and a claim name together, so as wide as a name column.
    size: 240,
    accessorKey: "claim",
    header: "Claim",
    cell: ({ row }) => <ClaimRef claim={row.original.claim} />,
  },
  {
    size: 160,
    accessorKey: "storageClass",
    header: "Storage Class",
    cell: ({ row }) => <StorageClassRef name={row.original.storageClass} />,
  },
  {
    size: 80,
    accessorKey: "age",
    header: () => <T section="columns" k="age" />,
  },
];

export const PersistentVolumeList =
  createResourceListPage<PersistentVolumeInfo>({
    resourceType: ResourceType.PersistentVolume,
    title: "Persistent Volumes",
    description: ({ t }) => t("empty", "persistentVolumesAre"),
    scope: "cluster",
    searchKey: "name",
    fetcher: () => commands.listPersistentVolumes(null),
    watch: () => commands.subscribePersistentvolumeWatch(),
    deleter: (item) => commands.deletePersistentVolume(item.name),
    columns,
  });
