import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";
import type { SecretInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createDataKeysColumn,
} from "@/components/resources/columns";
import { createResourceListPage } from "@/components/resources/createResourceListPage";

export const columns = (): ColumnDef<SecretInfo>[] => [
  createNameColumn<SecretInfo>(ResourceType.Secret),
  createNamespaceColumn<SecretInfo>(),
  {
    // `dockerconfigjson`, `service-account-token` — the longest of these is
    // wider than the resource names beside it.
    size: 180,
    id: "type",
    header: columnHeader("columns", "type"),
    meta: {
      share: (row: SecretInfo) => ({
        text: row.type.replace("kubernetes.io/", ""),
        mono: true,
      }),
    },
    // A secret's type is a classification, not a state. The previous
    // colour-per-type table spent four hues telling the reader something
    // the word already says.
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut">
        {row.original.type.replace("kubernetes.io/", "")}
      </span>
    ),
  },
  createDataKeysColumn<SecretInfo>(),
  createAgeColumn<SecretInfo>(),
];

export const SecretList = createResourceListPage<SecretInfo>({
  resourceType: ResourceType.Secret,
  title: "Secrets",
  fetcher: ({ scope }) => commands.listSecretsIn(scope),
  watch: ({ scope }) => commands.subscribeSecretWatch(scope),
  deleter: (item) => commands.deleteSecret(item.name, item.namespace),
  columns,
});
