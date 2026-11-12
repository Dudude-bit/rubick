import type { ColumnDef } from "@/components/ui/table-features";
import { T } from "@/i18n/T";
import { columnHeader } from "@/i18n/column-header";
import type { StorageClassInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { whole } from "@/lib/namespace-scope";
import type { T as Translate } from "@/i18n/useT";
import { widestText } from "@/lib/text-width";
import {
  createAgeColumn,
  nameCellPx,
  wordsFloor,
  yielding,
} from "../../../-list/columns";
import { ResourceType } from "@/lib/resource-registry";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ResourceRef } from "@/components/object/ResourceRef";
import { createResourceListPage } from "../../../-list/createResourceListPage";
import { None } from "@/components/ui/none";

/** `kubernetes.io/no-provisioner` whole; a longer driver name is on hover. */
const PROVISIONER_GLYPHS = 32;

/** The longest name, and the default class's with its marker and the 8px before it. */
const nameFloor = (t: Translate, rows: readonly StorageClassInfo[]) =>
  Math.max(
    nameCellPx(t, rows),
    ...rows
      .filter((row) => row.isDefault)
      .map(
        (row) =>
          nameCellPx(t, [row]) +
          8 +
          widestText([t("empty", "defaultClassBadge")], "caption", 6.6)
      )
  );

export const columns = (): ColumnDef<StorageClassInfo>[] => [
  {
    // The name plus the "default" marker that sits beside it.
    size: 300,
    accessorKey: "name",
    meta: { floor: nameFloor },
    header: columnHeader("columns", "name"),
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
          <span className="text-[11px] text-fg-fnt">
            <T section="empty" k="defaultClassBadge" />
          </span>
        )}
      </span>
    ),
  },
  {
    // A CSI driver name in full: `pd.csi.storage.gke.io`, `rancher.io/local-path`.
    size: 240,
    accessorKey: "provisioner",
    header: columnHeader("columns", "provisioner"),
    meta: {
      ideal: wordsFloor<StorageClassInfo>(
        (row) => row.provisioner,
        "mono",
        PROVISIONER_GLYPHS
      ),
    },
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut" title={row.original.provisioner}>
        {row.original.provisioner}
      </span>
    ),
  },
  {
    size: 120,
    accessorKey: "reclaimPolicy",
    header: columnHeader("columns", "reclaimPolicy"),
    cell: ({ row }) => (
      <span className="text-fg-mid">{row.original.reclaimPolicy}</span>
    ),
  },
  {
    // "WaitForFirstConsumer" is one unbreakable word.
    size: 170,
    accessorKey: "volumeBindingMode",
    header: columnHeader("columns", "bindingMode"),
    cell: ({ row }) => (
      <span className="text-fg-mid">{row.original.volumeBindingMode}</span>
    ),
    meta: {
      yields: 4,
      floor: wordsFloor<StorageClassInfo>((row) => row.volumeBindingMode),
    },
  },
  {
    size: 100,
    accessorKey: "allowVolumeExpansion",
    header: columnHeader("columns", "expansion"),
    cell: ({ row }) => (
      <span className="text-fg-mid">
        {row.original.allowVolumeExpansion ? (
          <T section="columns" k="allowed" />
        ) : (
          <T section="columns" k="notAllowed" />
        )}
      </span>
    ),
    meta: { yields: 2 },
  },
  {
    // "4 params", with the pairs themselves in the tooltip.
    size: 110,
    id: "parameters",
    accessorFn: (row) =>
      Object.entries(row.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(" "),
    header: columnHeader("columns", "parameters"),
    cell: ({ row }) => {
      const params = Object.entries(row.original.parameters);
      if (params.length === 0) return <None />;
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
    meta: { yields: 1 },
  },
  yielding(createAgeColumn<StorageClassInfo>(), 3),
];

export const StorageClassList = createResourceListPage<StorageClassInfo>({
  resourceType: ResourceType.StorageClass,
  title: "Storage Classes",
  scope: "cluster",
  fetcher: () => commands.listStorageClasses(null).then(whole),
  watch: () => commands.subscribeStorageclassWatch(),
  deleter: (item) => commands.deleteStorageClass(item.name),
  columns,
});
