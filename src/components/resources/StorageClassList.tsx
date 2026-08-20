import type { ColumnDef } from "@tanstack/react-table";
import { T } from "@/i18n/T";
import type { StorageClassInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ResourceRef } from "./ResourceRef";
import { createResourceListPage } from "./createResourceListPage";

export const columns = (): ColumnDef<StorageClassInfo>[] => [
  {
    // The name plus the "default" marker that sits beside it.
    size: 300,
    accessorKey: "name",
    header: () => <T section="columns" k="name" />,
    cell: ({ row }) => (
      <span className="flex items-baseline gap-2">
        <ResourceRef
          kind={ResourceType.StorageClass}
          name={row.original.name}
          showKind={false}
        />
        {/* Which class a PVC gets when it names none is worth saying in
         *  words: a gold star said it in colour and shape alone. */}
        {row.original.isDefault && (
          <span className="text-[11px] text-fg-fnt">default</span>
        )}
      </span>
    ),
  },
  {
    // A CSI driver name in full: `pd.csi.storage.gke.io`, `rancher.io/local-path`.
    size: 240,
    accessorKey: "provisioner",
    header: "Provisioner",
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut">{row.original.provisioner}</span>
    ),
  },
  {
    size: 120,
    accessorKey: "reclaimPolicy",
    header: () => <T section="columns" k="reclaimPolicy" />,
    cell: ({ row }) => (
      <span className="text-fg-mid">{row.original.reclaimPolicy}</span>
    ),
  },
  {
    // "WaitForFirstConsumer" is one unbreakable word.
    size: 170,
    accessorKey: "volumeBindingMode",
    header: () => <T section="columns" k="bindingMode" />,
    cell: ({ row }) => (
      <span className="text-fg-mid">{row.original.volumeBindingMode}</span>
    ),
  },
  {
    size: 100,
    accessorKey: "allowVolumeExpansion",
    header: () => <T section="columns" k="expansion" />,
    cell: ({ row }) => (
      <span className="text-fg-mid">
        {row.original.allowVolumeExpansion ? (
          <T section="columns" k="allowed" />
        ) : (
          <T section="columns" k="disabled" />
        )}
      </span>
    ),
  },
  {
    // "4 params", with the pairs themselves in the tooltip.
    size: 110,
    accessorKey: "parameters",
    header: () => <T section="columns" k="parameters" />,
    cell: ({ row }) => {
      const params = Object.entries(row.original.parameters);
      if (params.length === 0) return <span className="text-fg-fnt">—</span>;
      return (
        <Tooltip>
          <TooltipTrigger className="text-fg-mut">
            <T section="count" k="params" values={{ n: params.length }} />
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
    size: 80,
    accessorKey: "age",
    header: () => <T section="columns" k="age" />,
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
