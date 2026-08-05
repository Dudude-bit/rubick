import { Link } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";

import type { PersistentVolumeInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { StatusBadge } from "@/components/ui/status-badge";
import { createAccessModesColumn, createCapacityColumn } from "./columns";
import { createResourceListPage } from "./createResourceListPage";

const columns = (): ColumnDef<PersistentVolumeInfo>[] => [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <Link
        to={getResourceDetailUrl(
          ResourceType.PersistentVolume,
          row.original.name
        )}
        className="font-mono text-info hover:underline"
      >
        {row.original.name}
      </Link>
    ),
  },
  createCapacityColumn<PersistentVolumeInfo>(),
  createAccessModesColumn<PersistentVolumeInfo>(),
  {
    accessorKey: "reclaimPolicy",
    header: "Reclaim Policy",
    cell: ({ row }) => (
      <span className="text-fg-mid">{row.original.reclaimPolicy}</span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "claim",
    header: "Claim",
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut">{row.original.claim || "—"}</span>
    ),
  },
  {
    accessorKey: "storageClass",
    header: "Storage Class",
    cell: ({ row }) => (
      <span className="text-fg-mut">{row.original.storageClass || "—"}</span>
    ),
  },
  {
    accessorKey: "age",
    header: "Age",
  },
];

export const PersistentVolumeList =
  createResourceListPage<PersistentVolumeInfo>({
    resourceType: ResourceType.PersistentVolume,
    title: "Persistent Volumes",
    description:
      "Cluster-wide storage resources provisioned by an administrator",
    scope: "cluster",
    searchKey: "name",
    fetcher: () => commands.listPersistentVolumes(null),
    watch: () => commands.subscribePersistentvolumeWatch(),
    deleter: (item) => commands.deletePersistentVolume(item.name),
    columns,
  });
