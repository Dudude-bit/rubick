import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ColumnDef } from "@tanstack/react-table";
import { Eye, Trash2, List } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ActionMenu } from "@/components/ui/action-menu";
import { DataTable } from "@/components/ui/data-table";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/use-toast";
import { useClusterStore } from "@/stores/clusterStore";
import { ResourceListHeader } from "@/components/resources/ResourceListHeader";
import { createAgeColumn } from "@/components/resources/columns";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { commands } from "@/lib/commands";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import type { CrdInfo } from "@/generated/types";

const CRD_PATH = `/${toPlural(ResourceType.CustomResourceDefinition)}`;

// CRDs are cluster-scoped, so `namespace` carries the API group instead:
// it is the field DataTable groups its captions on, and the API group is
// the only grouping a CRD list has.
type CrdListItem = CrdInfo & { namespace: string };

const getCrdRowId = (row: CrdListItem) => row.name;

const crdHref = (name: string) => `${CRD_PATH}/${encodeURIComponent(name)}`;

export function Crds() {
  const { isConnected } = useClusterStore();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<CrdListItem | null>(null);

  const {
    data: crdGroups = [],
    isLoading,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["crds", "grouped"],
    queryFn: async () => {
      try {
        return await commands.listCrds(true);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: isConnected,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.slow,
  });

  const deleteMutation = useMutation({
    mutationFn: async (item: CrdListItem) => {
      try {
        await commands.deleteCrd(item.name);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    onSuccess: (_, item) => {
      toast({
        title: "CRD deleted",
        description: `${item.name} has been deleted.`,
      });
      queryClient.invalidateQueries({ queryKey: ["crds"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to delete CRD",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const crds = useMemo<CrdListItem[]>(
    () =>
      crdGroups.flatMap((group) =>
        group.crds.map((crd) => ({ ...crd, namespace: group.group || "core" }))
      ),
    [crdGroups]
  );

  const columns = useMemo<ColumnDef<CrdListItem>[]>(
    () => [
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => (
          <Link
            to={crdHref(row.original.name)}
            className="font-mono text-info hover:underline"
          >
            {row.original.kind}
          </Link>
        ),
      },
      {
        accessorKey: "plural",
        header: "Plural",
        cell: ({ row }) => (
          <span className="font-mono text-fg-mut">{row.original.plural}</span>
        ),
      },
      {
        accessorKey: "scope",
        header: "Scope",
        cell: ({ row }) => (
          <span className="text-fg-mut">{row.original.scope}</span>
        ),
      },
      {
        accessorKey: "version",
        header: "Version",
        cell: ({ row }) => (
          <span className="font-mono text-fg-mut">{row.original.version}</span>
        ),
      },
      {
        accessorKey: "shortNames",
        header: "Short names",
        cell: ({ row }) => {
          const shortNames = row.original.shortNames;
          if (!shortNames || shortNames.length === 0) {
            return <span className="text-fg-fnt">—</span>;
          }
          return (
            <span className="font-mono text-fg-mut">
              {shortNames.join(" ")}
            </span>
          );
        },
      },
      createAgeColumn<CrdListItem>(),
      {
        id: "actions",
        cell: ({ row }) => (
          <ActionMenu>
            <DropdownMenuItem asChild>
              <Link to={crdHref(row.original.name)}>
                <Eye className="mr-2 h-3.5 w-3.5" />
                View details
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to={`${crdHref(row.original.name)}/instances`}>
                <List className="mr-2 h-3.5 w-3.5" />
                View instances
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-err"
              onClick={() => setDeleteTarget(row.original)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </ActionMenu>
        ),
      },
    ],
    []
  );

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel="CRDs" />;
  }

  return (
    <div className="flex flex-col gap-2 animate-in fade-in duration-200">
      <ResourceListHeader
        title="Custom Resource Definitions"
        count={
          crds.length === 0
            ? "none"
            : `${crds.length} · ${crdGroups.length} API ${crdGroups.length === 1 ? "group" : "groups"}`
        }
        dataUpdatedAt={dataUpdatedAt}
      />
      {/* One table, one search field. The previous page nested a full
          DataTable — search, density toggle, pagination — inside every
          collapsible API group, so the same chrome appeared a dozen times
          over. The group is a caption row instead. */}
      <DataTable
        columns={columns}
        data={crds}
        isLoading={isLoading}
        searchKey="kind"
        searchPlaceholder="Search CRDs..."
        getRowId={getCrdRowId}
        getRowHref={(row) => crdHref(row.name)}
        groupByNamespace
        rowLabel="CRDs"
        emptyMessage="This cluster has no custom resource definitions."
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        title="Delete CRD?"
        description={`Deleting "${deleteTarget?.name}" also deletes every instance of this custom resource.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        confirmDisabled={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) {
            deleteMutation.mutate(deleteTarget);
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}
