import { Link } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import type { StorageClassInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { createResourceListPage } from "./createResourceListPage";

const columns = (): ColumnDef<StorageClassInfo>[] => [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <span className="flex items-baseline gap-2">
        <Link
          to={getResourceDetailUrl(
            ResourceType.StorageClass,
            row.original.name
          )}
          className="font-mono text-info hover:underline"
        >
          {row.original.name}
        </Link>
        {/* Which class a PVC gets when it names none is worth saying in
         *  words: a gold star said it in colour and shape alone. */}
        {row.original.isDefault && (
          <span className="text-[11px] text-fg-fnt">default</span>
        )}
      </span>
    ),
  },
  {
    accessorKey: "provisioner",
    header: "Provisioner",
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut">{row.original.provisioner}</span>
    ),
  },
  {
    accessorKey: "reclaimPolicy",
    header: "Reclaim Policy",
    cell: ({ row }) => (
      <span className="text-fg-mid">{row.original.reclaimPolicy}</span>
    ),
  },
  {
    accessorKey: "volumeBindingMode",
    header: "Binding Mode",
    cell: ({ row }) => (
      <span className="text-fg-mid">{row.original.volumeBindingMode}</span>
    ),
  },
  {
    accessorKey: "allowVolumeExpansion",
    header: "Expansion",
    cell: ({ row }) => (
      <span className="text-fg-mid">
        {row.original.allowVolumeExpansion ? "allowed" : "disabled"}
      </span>
    ),
  },
  {
    accessorKey: "parameters",
    header: "Parameters",
    cell: ({ row }) => {
      const params = Object.entries(row.original.parameters);
      if (params.length === 0) return <span className="text-fg-fnt">—</span>;
      return (
        <Tooltip>
          <TooltipTrigger className="text-fg-mut">
            {params.length} params
          </TooltipTrigger>
          <TooltipContent>
            {params.map(([key, value]) => (
              <div key={key} className="font-mono text-xs">
                {key}
                <span className="text-fg-fnt">=</span>
                {value}
              </div>
            ))}
          </TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    accessorKey: "age",
    header: "Age",
  },
];

export const StorageClassList = createResourceListPage<StorageClassInfo>({
  resourceType: ResourceType.StorageClass,
  title: "Storage Classes",
  description: "Describes the classes of storage available in the cluster",
  scope: "cluster",
  searchKey: "name",
  fetcher: () => commands.listStorageClasses(null),
  watch: () => commands.subscribeStorageclassWatch(),
  deleter: (item) => commands.deleteStorageClass(item.name),
  columns,
});
