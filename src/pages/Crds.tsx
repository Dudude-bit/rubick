import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { Link } from "react-router-dom";
import { ColumnDef } from "@tanstack/react-table";
import { Eye, Trash2, List } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ActionMenu } from "@/components/ui/action-menu";
import { DataTable } from "@/components/ui/data-table";
import { byNamespace } from "@/components/ui/row-grouping";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RouteLink } from "@/components/ui/route-link";
import { useToast } from "@/components/ui/use-toast";
import { useClusterStore } from "@/stores/clusterStore";
import { ResourceListHeader } from "@/components/resources/ResourceListHeader";
import { createAgeColumn } from "@/components/resources/columns";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { commands } from "@/lib/commands";
import { STALE_TIMES } from "@/lib/refresh";
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
    freshness,
  } = useLiveQuery({
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
    refresh: "slow",
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
        size: 220,
        cell: ({ row }) => (
          <RouteLink
            to={crdHref(row.original.name)}
            className="font-mono text-info hover:underline"
          >
            {row.original.kind}
          </RouteLink>
        ),
      },
      {
        accessorKey: "plural",
        header: "Plural",
        size: 200,
        cell: ({ row }) => (
          <span className="font-mono text-fg-mut">{row.original.plural}</span>
        ),
      },
      {
        accessorKey: "scope",
        header: "Scope",
        size: 110,
        cell: ({ row }) => (
          <span className="text-fg-mut">{row.original.scope}</span>
        ),
      },
      {
        accessorKey: "version",
        header: "Version",
        size: 110,
        cell: ({ row }) => (
          <span className="font-mono text-fg-mut">{row.original.version}</span>
        ),
      },
      {
        accessorKey: "shortNames",
        header: "Short names",
        size: 160,
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
        // One icon-sized menu, not the 150px a column gets by saying nothing:
        // the table is `table-fixed`, so an unsized column takes a full share
        // of the width away from the names beside it.
        size: 60,
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
    <div className="flex h-full min-h-0 flex-col gap-2 animate-in fade-in duration-200">
      <ResourceListHeader
        title="Custom Resource Definitions"
        count={
          crds.length === 0
            ? "none"
            : `${crds.length} · ${crdGroups.length} API ${crdGroups.length === 1 ? "group" : "groups"}`
        }
        dataUpdatedAt={dataUpdatedAt}
        slowed={freshness.slowed}
      />
      {/* One table, one search field. The previous page nested a full
          DataTable — search, density toggle, pagination — inside every
          collapsible API group, so the same chrome appeared a dozen times
          over. The group is a caption row instead. */}
      <DataTable
        columns={columns}
        data={crds}
        fill
        isLoading={isLoading}
        searchKey="kind"
        searchPlaceholder="Search CRDs..."
        getRowId={getCrdRowId}
        getRowHref={(row) => crdHref(row.name)}
        grouping={byNamespace<CrdListItem>("CRDs")}
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
