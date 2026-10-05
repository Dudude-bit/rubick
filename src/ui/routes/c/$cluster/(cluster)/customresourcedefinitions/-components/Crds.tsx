import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@/components/ui/table-features";
import { Eye, Trash2, List } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ActionMenu } from "@/components/ui/action-menu";
import { DataTable } from "@/components/ui/data-table";
import { byNamespace } from "@/components/ui/row-grouping";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { DangerousConfirmDialog } from "@/components/ui/dangerous-confirm-dialog";
import { CascadePreview } from "../../../-object/CascadePreview";
import { describeDeletion } from "../../../-peek/peek-actions";
import { useToast } from "@/components/ui/use-toast";
import { useClusterStore } from "@/stores/clusterStore";
import { ResourceListHeader } from "../../../-list/ResourceListHeader";
import { UnreadList } from "../../../-list/UnreadList";
import { KindAbout } from "@/components/object/KindAbout";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { createAgeColumn } from "../../../-list/columns";
import { isRefusal, normalizeTauriError } from "@/lib/error-utils";
import { ObjectLink } from "@/components/object/ResourceRef";
import { kindNoun, ResourceType } from "@/lib/resource-registry";
import { crdInstancesLink, hrefOf, objectLink } from "@/lib/links";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import type { CrdInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { T } from "@/i18n/T";
import { scopeKey } from "./crd-scope";
import { columnHeader } from "@/i18n/column-header";
import { toastError } from "@/lib/toast-error";
import { None } from "@/components/ui/none";

// CRDs are cluster-scoped, so `namespace` carries the API group instead:
// it is the field DataTable groups its captions on, and the API group is
// the only grouping a CRD list has.
type CrdListItem = CrdInfo & { namespace: string };

const getCrdRowId = (row: CrdListItem) => row.name;
const BY_API_GROUP = byNamespace<CrdListItem>(kindNoun("CRDs"));

const crdLink = (name: string) =>
  objectLink({ kind: ResourceType.CustomResourceDefinition, name })!;

export function Crds() {
  const t = useT();
  const { isConnected } = useClusterStore();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<CrdListItem | null>(null);
  const deletion = deleteTarget
    ? describeDeletion(
        ResourceType.CustomResourceDefinition,
        deleteTarget.name,
        null,
        undefined,
        t
      )
    : null;

  const {
    data: crdGroups = [],
    isLoading,
    error: crdsError,
    dataUpdatedAt,
    freshness,
  } = useLiveQuery({
    queryKey: queryKeys.crds(),
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
        title: t("action", "kindDeleted", { kind: "CRD" }),
        description: t("action", "kindDeletedDetail", {
          kind: "CRD",
          name: item.name,
        }),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.crds() });
    },
    onError: (error: Error) => {
      toastError(t("action", "deleteKindFailed", { kind: "CRD" }), error);
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
        header: columnHeader("columns", "kind"),
        size: 220,
        // An `ObjectLink` and not a `RouteLink`: the row's own href resolves
        // to a peek, so a click on the whitespace opens one. A name that
        // navigated instead left this list answering a click two different
        // ways inside one row — which is the thing #178 item 2 was about.
        cell: ({ row }) => (
          <ObjectLink
            kind={ResourceType.CustomResourceDefinition}
            name={row.original.name}
            className="font-mono text-info hover:underline"
          >
            {row.original.kind}
          </ObjectLink>
        ),
      },
      {
        accessorKey: "plural",
        header: columnHeader("columns", "plural"),
        size: 200,
        cell: ({ row }) => (
          <span className="font-mono text-fg-mut">{row.original.plural}</span>
        ),
      },
      {
        accessorKey: "scope",
        header: columnHeader("columns", "scope"),
        size: 110,
        cell: ({ row }) => (
          <span className="text-fg-mut">
            <T section="apiResources" k={scopeKey(row.original.scope)} />
          </span>
        ),
      },
      {
        accessorKey: "version",
        header: columnHeader("columns", "version"),
        size: 110,
        cell: ({ row }) => (
          <span className="font-mono text-fg-mut">{row.original.version}</span>
        ),
      },
      {
        accessorKey: "shortNames",
        header: columnHeader("columns", "shortNames"),
        size: 160,
        cell: ({ row }) => {
          const shortNames = row.original.shortNames;
          if (!shortNames || shortNames.length === 0) {
            return <None />;
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
              <Link {...crdLink(row.original.name)}>
                <Eye className="mr-2 h-3.5 w-3.5" />
                <T section="action" k="viewDetails" />
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link {...crdInstancesLink(row.original.name)}>
                <List className="mr-2 h-3.5 w-3.5" />
                <T section="action" k="viewInstances" />
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-err"
              onClick={() => setDeleteTarget(row.original)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              <T section="action" k="delete" />
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
        description={<KindAbout kind={ResourceType.CustomResourceDefinition} />}
        count={
          isLoading || crdsError
            ? undefined
            : crds.length === 0
              ? t("empty", "noneInline")
              : `${crds.length} · ${t("count", "apiGroups", { n: crdGroups.length })}`
        }
        actions={
          <ShareScreenAction
            screen={{
              title: "Custom Resource Definitions",
              kind: ResourceType.CustomResourceDefinition,
            }}
          />
        }
        dataUpdatedAt={dataUpdatedAt}
        slowed={freshness.slowed}
      />
      {/* One table, one search field. The previous page nested a full
          DataTable — search, density toggle, pagination — inside every
          collapsible API group, so the same chrome appeared a dozen times
          over. The group is a caption row instead. */}
      {crdsError && crds.length === 0 ? (
        <UnreadList
          error={crdsError}
          words={
            isRefusal(crdsError)
              ? t("nav", "noListAccess")
              : t("empty", "couldNotReadInScope", { label: "CRDs" })
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={crds}
          fill
          pageKeys
          isLoading={isLoading}
          searchPlaceholder={t("action", "searchKindPlaceholder", {
            kind: "CRDs",
          })}
          searchParam="q"
          getRowId={getCrdRowId}
          getRowHref={(row) => hrefOf(crdLink(row.name))}
          grouping={BY_API_GROUP}
          rowLabel="CRDs"
          share={{
            title: "Custom Resource Definitions",
            kind: ResourceType.CustomResourceDefinition,
          }}
          emptyMessage={t("empty", "noCrdsInCluster")}
        />
      )}

      <DangerousConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={deletion?.title ?? ""}
        description={deletion?.description}
        details={
          deleteTarget ? (
            <CascadePreview
              kind={ResourceType.CustomResourceDefinition}
              name={deleteTarget.name}
            />
          ) : null
        }
        confirmationText={deleteTarget?.name ?? ""}
        confirmLabel={t("action", "delete")}
        isLoading={deleteMutation.isPending}
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
