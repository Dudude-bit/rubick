import { useCallback, useMemo } from "react";
import { columnHeader } from "@/i18n/column-header";
import { useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@/components/ui/table-features";
import { CircleHelp, Eye, Trash2 } from "lucide-react";
import { RouteLink } from "@/components/ui/route-link";
import { StatusBadge } from "@/components/ui/status-badge";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { scopeCacheKey } from "@/lib/namespace-scope";
import { createAgeColumn, createNamespaceColumn } from "../../../-list/columns";
import { RealtimeAge } from "@/components/ui/realtime";
import { hrefOf, objectLink } from "@/lib/links";
import { statusRole } from "@/lib/status-role";
import { useCrdView } from "@/integrations";
import { drawnSeparately, printerCell } from "./printer-columns";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { ResourceList } from "../../../-list/ResourceList";
import type { CustomResourceInfo, PrinterColumn } from "@/generated/types";
import { STALE_TIMES } from "@/lib/refresh";
import { crdWidthsKey } from "@/lib/resource-identity";
import { getResourceRowId } from "@/lib/table-utils";
import { useWatchedList } from "@/hooks/useWatchedList";
import { useT } from "@/i18n/useT";
import { None } from "@/components/ui/none";

interface CustomResourceListProps {
  crdName: string;
  crdKind: string;
  crdGroup: string; // API group (e.g., "cert-manager.io")
  crdVersion: string; // Storage version (e.g., "v1") — used by the watch subscription
  crdPlural: string; // Plural name (e.g., "certificates")
  scope: "Namespaced" | "Cluster";
  printerColumns?: PrinterColumn[];
  embedded?: boolean; // If true, renders without header (for embedding in detail pages)
}

// Extended type to make namespace always a string for DataTable compatibility
type CustomResourceListItem = CustomResourceInfo & { namespace: string };

export function CustomResourceList({
  crdName,
  crdKind,
  crdGroup,
  crdVersion,
  crdPlural,
  scope,
  printerColumns = [],
  embedded = false,
}: CustomResourceListProps) {
  const t = useT();
  const nsScope = useNamespaceScope();

  // How the vendor that installed this CRD draws it, if the app knows one.
  const crdView = useCrdView(crdGroup, crdKind);

  const navigate = useNavigate();
  // A cluster-scoped CRD ignores the namespace selection; a namespaced one is
  // read and watched across it.
  const isNamespaced = scope === "Namespaced";
  const wire = isNamespaced ? nsScope.wire : null;
  const oneNamespace = wire?.length === 1 ? wire[0] : null;
  const cacheKey = isNamespaced ? scopeCacheKey(nsScope.scope) : null;

  // Generate detail link for a custom resource. Wrapped in
  // `useCallback` so the two `useMemo` blocks below can list it as a
  // direct dependency — this is what `react-hooks/exhaustive-deps`
  // wants to see, instead of unrolling its `[scope, crdName]` closure
  // captures into the consumer's dep arrays.
  const getDetailLink = useCallback(
    (item: CustomResourceListItem) =>
      objectLink({
        kind: crdKind,
        name: item.name,
        namespace: scope === "Namespaced" ? item.namespace : null,
        crd: crdName,
      })!,
    [scope, crdKind, crdName]
  );

  const quickActions = useMemo<
    (
      setDeleteTarget: (item: CustomResourceListItem) => void
    ) => QuickAction<CustomResourceListItem>[]
  >(
    () => (setDeleteTarget) => [
      {
        icon: Eye,
        label: t("action", "viewDetails"),
        onClick: (item: CustomResourceListItem) =>
          navigate(getDetailLink(item)),
      },
      {
        icon: Trash2,
        label: t("action", "delete"),
        onClick: (item: CustomResourceListItem) => setDeleteTarget(item),
        variant: "destructive" as const,
      },
    ],
    [navigate, getDetailLink, t]
  );

  // Build columns from the vendor's view, or from the CRD's printer columns
  const baseColumns = useMemo<ColumnDef<CustomResourceListItem>[]>(() => {
    const cols: ColumnDef<CustomResourceListItem>[] = [];

    // The name is the row's identity and where a person aims, so it carries
    // the real anchor. An instance's path is built from the CRD, not from
    // kind and name, which is why this is not a ResourceRef.
    cols.push({
      size: 320,
      accessorKey: "name",
      header: columnHeader("columns", "name"),
      cell: ({ row }) => (
        <RouteLink
          {...getDetailLink(row.original)}
          className="font-mono text-info hover:underline"
        >
          {row.original.name}
        </RouteLink>
      ),
    });

    // Namespace column for namespaced resources
    if (scope === "Namespaced") {
      cols.push(createNamespaceColumn<CustomResourceListItem>());
    }

    const vendorColumns = crdView?.columnsFor(crdKind);

    // Neither a vendor's view nor a CRD's printer columns say how wide their
    // values are, and this is the one table in the app whose shape is decided
    // by whatever is installed on the cluster. An even share is the only
    // honest answer; the name column above still gets its own.
    const UNKNOWN_COLUMN_SIZE = 140;

    if (vendorColumns && vendorColumns.length > 0) {
      for (const pc of vendorColumns) {
        cols.push({
          size: UNKNOWN_COLUMN_SIZE,
          id: pc.id,
          header: t("columns", pc.header),
          cell: ({ row }) => {
            const value = pc.accessor(row.original, t);
            if (pc.cell) {
              return pc.cell(value, t);
            }
            // Default formatting with the status config the vendor supplied
            if (crdView && typeof value === "string") {
              return <StatusBadge status={value} />;
            }
            if (value === null || value === undefined) {
              return <None />;
            }
            return String(value);
          },
        });
      }
    } else {
      // Fallback to printer columns from CRD
      for (const pc of printerColumns) {
        if (drawnSeparately(pc.name)) continue;

        cols.push({
          size: UNKNOWN_COLUMN_SIZE,
          id: pc.name.toLowerCase().replace(/\s+/g, "-"),
          header: pc.name,
          cell: ({ row }) => {
            const cell = printerCell(row.original, pc.jsonPath);
            return cell.evaluated ? (
              formatColumnValue(cell.value, pc.columnType)
            ) : (
              <NotEvaluated expression={pc.jsonPath} />
            );
          },
        });
      }
    }

    // Age column (always last before actions)
    cols.push(createAgeColumn<CustomResourceListItem>());

    return cols;
  }, [crdKind, scope, printerColumns, crdView, getDetailLink, t]);

  // Real-time updates via the resource-watch subsystem. Same pattern
  // as the other migrated lists: watch events update the cache via
  // setQueryData; if the watch fails (typically because the kubeconfig
  // user lacks the `watch` verb on the CRD), the toast fires and
  // the list falls back to its default poll rate.
  const queryKey = useMemo(
    // Not `as const`: one of the two readers wants a mutable array, and a
    // copy made for it is what defeated this memo in the first place.
    () => queryKeys.customResourceList(crdName, cacheKey),
    [crdName, cacheKey]
  );
  const subscribeCustomResource = useCallback(
    () =>
      commands.subscribeCustomResourceWatch(
        crdGroup,
        crdVersion,
        crdKind,
        crdPlural,
        wire
      ),
    [crdGroup, crdVersion, crdKind, crdPlural, wire]
  );
  const { live, refresh, resyncing } = useWatchedList<CustomResourceListItem>({
    enabled: true,
    subscribe: subscribeCustomResource,
    // The memoised array itself, not a copy of it: the watch effect has this
    // in its dependencies, and a fresh array on every render tore the subscription
    // down and opened another one on every single render.
    queryKey,
    reportFailure: crdKind,
  });

  const noun = useMemo(
    () => ({ kind: crdKind, plural: crdPlural }),
    [crdKind, crdPlural]
  );

  return (
    <ResourceList<CustomResourceListItem>
      title={t("count", "kindInstances", { kind: crdKind })}
      noun={noun}
      queryKey={queryKey}
      getRowId={getResourceRowId}
      queryFn={async () => {
        const answer = await commands.listCustomResourcesIn(crdName, wire);
        return {
          ...answer,
          rows: answer.rows.map((r) => ({
            ...r,
            namespace: r.namespace || "",
          })),
        };
      }}
      columns={baseColumns}
      quickActions={quickActions}
      emptyStateLabel={crdPlural}
      narrowingHelps={isNamespaced}
      listQuery={{
        group: crdGroup,
        resource: crdPlural,
        namespaced: isNamespaced,
      }}
      widthsKey={crdWidthsKey(crdPlural, crdGroup)}
      // The generic fallback ("No resources of this type…") is the one
      // message a CRD list must not show: the whole question a reader
      // opens it with is whether this kind exists on the cluster at all.
      emptyMessage={
        oneNamespace
          ? t("empty", "crdNoInstancesInNamespace", {
              kind: crdKind,
              namespace: oneNamespace,
            })
          : t("empty", "crdNoInstances", { kind: crdKind })
      }
      deleteConfig={{
        mutationFn: (item) =>
          commands.deleteCustomResource(
            crdName,
            item.name,
            item.namespace || null
          ),
        invalidateQueryKeys: [queryKeys.customResourceLists(crdName)],
        resourceType: crdKind,
      }}
      staleTime={STALE_TIMES.resourceList}
      refresh={refresh}
      live={live}
      resyncing={resyncing}
      searchPlaceholder={t("action", "searchKindPlaceholder", {
        kind: crdKind,
      })}
      embedded={embedded}
      getRowHref={(row) => hrefOf(getDetailLink(row))}
    />
  );
}

/** A printer column this app cannot evaluate, never drawn as the cluster's "none". */
function NotEvaluated({ expression }: { expression: string }) {
  const t = useT();
  return (
    <span
      className="inline-flex items-center gap-1 text-fg-mut"
      title={t("empty", "printerNotEvaluated", { expression })}
    >
      <CircleHelp className="h-3 w-3 flex-none text-warn" aria-hidden="true" />
      {t("empty", "notEvaluatedLower")}
    </span>
  );
}

// Helper function to format column value based on type
function formatColumnValue(
  value: unknown,
  columnType: string
): React.ReactNode {
  if (value === null || value === undefined) {
    return <None />;
  }

  switch (columnType) {
    case "date":
      if (typeof value === "string") {
        return <RealtimeAge timestamp={value} />;
      }
      return String(value);

    case "integer":
    case "number":
      return <span className="font-mono">{String(value)}</span>;

    case "boolean":
      // A CRD's booleans are settings, not lifecycle — `true` gets no pill.
      return <span className="font-mono text-fg-mid">{String(value)}</span>;

    case "string":
    default:
      // A printer column whose value names a state the app already knows how
      // to colour is the one case that earns a badge. The vocabulary lives in
      // `statusRole`, so this no longer keeps a third copy of it.
      if (typeof value === "string" && isKnownStatus(value)) {
        return <StatusBadge status={value} />;
      }
      if (typeof value === "object") value = JSON.stringify(value);
      // A printer column is whatever the CRD author chose to show; some are
      // long, and the cell is the only place it appears.
      return (
        <span
          className="max-w-[200px] truncate text-fg-mid"
          title={String(value)}
        >
          {String(value)}
        </span>
      );
  }
}

/** Only render a badge when the string is a state, not free text. */
function isKnownStatus(value: string): boolean {
  return statusRole(value) !== "neutral" || value.toLowerCase() === "unknown";
}
