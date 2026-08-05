import type { ColumnDef } from "@tanstack/react-table";
import { Lock } from "lucide-react";
import type { SecretInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import {
  createNamespaceColumn,
  createAgeColumn,
  createDataKeysColumn,
} from "./columns";
import { createResourceListPage } from "./createResourceListPage";

const columns = (): ColumnDef<SecretInfo>[] => [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <Lock className="h-3 w-3 flex-none text-fg-fnt" aria-hidden="true" />
        <span className="font-mono text-info">{row.original.name}</span>
      </div>
    ),
  },
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
