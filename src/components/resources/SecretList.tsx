import type { ColumnDef } from "@tanstack/react-table";
import type { SecretInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createDataKeysColumn,
} from "./columns";
import { createResourceListPage } from "./createResourceListPage";

const columns = (): ColumnDef<SecretInfo>[] => [
  createNameColumn<SecretInfo>(ResourceType.Secret),
  createNamespaceColumn<SecretInfo>(),
  {
    id: "type",
    header: "Type",
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
  fetcher: ({ namespace }) =>
    commands.listSecrets({
      namespace,
      labelSelector: null,
      fieldSelector: null,
      secretType: null,
      limit: null,
    }),
  watch: ({ namespace }) => commands.subscribeSecretWatch(namespace),
  deleter: (item) => commands.deleteSecret(item.name, item.namespace),
  columns,
});
