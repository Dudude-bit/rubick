import { useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ColumnDef } from "@tanstack/react-table";
import { Eye, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useClusterStore } from "@/stores/clusterStore";
import { createAgeColumn, createNamespaceColumn } from "./columns";
import { RealtimeAge } from "@/components/ui/realtime";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { statusRole } from "@/lib/status-role";
import { usePlugin } from "@/lib/crd-plugins";
import { getKindSpecificColumns } from "@/lib/crd-plugins/plugins";
import { commands } from "@/lib/commands";
import { ResourceList } from "@/components/resources/ResourceList";
import type { CustomResourceInfo, PrinterColumn } from "@/generated/types";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { getResourceRowId } from "@/lib/table-utils";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";

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
  const { currentNamespace } = useClusterStore();

  // Get plugin for this CRD (if any)
  const plugin = usePlugin(crdGroup, crdKind, crdPlural);

  const navigate = useNavigate();
  const namespace = scope === "Namespaced" ? currentNamespace : null;

  // Generate detail path for a custom resource. Wrapped in
  // `useCallback` so the two `useMemo` blocks below can list it as a
  // direct dependency — this is what `react-hooks/exhaustive-deps`
  // wants to see, instead of unrolling its `[scope, crdName]` closure
  // captures into the consumer's dep arrays.
  const getDetailPath = useCallback(
    (item: CustomResourceListItem) =>
      scope === "Namespaced"
        ? `/${toPlural(ResourceType.CustomResourceDefinition)}/${encodeURIComponent(crdName)}/instances/${item.namespace}/${item.name}`
        : `/${toPlural(ResourceType.CustomResourceDefinition)}/${encodeURIComponent(crdName)}/instances/${item.name}`,
    [scope, crdName]
  );

  const quickActions = useMemo<
    (
      setDeleteTarget: (item: CustomResourceListItem) => void
    ) => QuickAction<CustomResourceListItem>[]
  >(
    () => (setDeleteTarget) => [
      {
        icon: Eye,
        label: "View Details",
        onClick: (item: CustomResourceListItem) =>
          navigate(getDetailPath(item)),
      },
      {
        icon: Trash2,
        label: "Delete",
        onClick: (item: CustomResourceListItem) => setDeleteTarget(item),
        variant: "destructive" as const,
      },
    ],
    [navigate, getDetailPath]
  );

  // Build columns from printer columns and plugin
  const baseColumns = useMemo<ColumnDef<CustomResourceListItem>[]>(() => {
    const cols: ColumnDef<CustomResourceListItem>[] = [];

    // Name column (always first) - use simple text since row is clickable
    cols.push({
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <Link
          to={getDetailPath(row.original)}
          className="font-mono text-info hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    });

    // Namespace column for namespaced resources
    if (scope === "Namespaced") {
      cols.push(createNamespaceColumn<CustomResourceListItem>());
    }

    // Try to get plugin-specific columns first
    const pluginColumns = plugin
      ? getKindSpecificColumns(plugin.id, crdKind) || plugin.columns
      : null;

    if (pluginColumns && pluginColumns.length > 0) {
      // Use plugin columns
      for (const pc of pluginColumns) {
        cols.push({
          id: pc.id,
          header: pc.header,
          cell: ({ row }) => {
            const value = pc.accessor(row.original);
            if (pc.cell) {
              return pc.cell(value);
            }
            // Default formatting with status config from plugin
            if (plugin?.status && typeof value === "string") {
              return <StatusBadge status={value} />;
            }
            if (value === null || value === undefined) {
              return <span className="text-fg-fnt">—</span>;
            }
            return String(value);
          },
        });
      }
    } else {
      // Fallback to printer columns from CRD
      for (const pc of printerColumns) {
        // Skip NAME and AGE as we handle them separately
        if (pc.name === "NAME" || pc.name === "AGE") continue;

        cols.push({
          id: pc.name.toLowerCase().replace(/\s+/g, "-"),
          header: pc.name,
          cell: ({ row }) => {
            const value = getValueFromJsonPath(row.original, pc.jsonPath);
            return formatColumnValue(value, pc.columnType);
          },
        });
      }
    }

    // Age column (always last before actions)
    cols.push(createAgeColumn<CustomResourceListItem>());

    return cols;
  }, [crdKind, scope, printerColumns, plugin, getDetailPath]);

  // Real-time updates via the resource-watch subsystem. Same pattern
  // as the other migrated lists: watch events update the cache via
  // setQueryData; if the watch fails (typically because the kubeconfig
  // user lacks the `watch` verb on the CRD), the toast fires and
  // refetchInterval falls back to its default 2s.
  const queryKey = useMemo(
    () => ["custom-resources", crdName, namespace ?? "all"] as const,
    [crdName, namespace]
  );
  const subscribeCustomResource = useCallback(
    () =>
      commands.subscribeCustomResourceWatch(
        crdGroup,
        crdVersion,
        crdKind,
        crdPlural,
        namespace || null
      ),
    [crdGroup, crdVersion, crdKind, crdPlural, namespace]
  );
  const { toast } = useToast();
  const [watchFailed, setWatchFailed] = useState(false);
  const handleWatchError = useCallback(
    (err: string) => {
      if (watchFailed) return;
      setWatchFailed(true);
      toast({
        title: "Real-time updates unavailable",
        description: `${crdKind}: falling back to periodic refresh. ${err}`,
      });
    },
    [toast, watchFailed, crdKind]
  );
  useResourceWatch<CustomResourceListItem>({
    enabled: true,
    subscribe: subscribeCustomResource,
    queryKey: [...queryKey],
    onError: handleWatchError,
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });

  return (
    <ResourceList<CustomResourceListItem>
      title={(count) => `${crdKind} Instances (${count})`}
      queryKey={[...queryKey]}
      getRowId={getResourceRowId}
      queryFn={async () => {
        const result = await commands.listCustomResources(
          crdName,
          namespace || null,
          null,
          null
        );
        return result.map((r) => ({
          ...r,
          namespace: r.namespace || "",
        }));
      }}
      columns={baseColumns}
      quickActions={quickActions}
      emptyStateLabel={crdPlural}
      deleteConfig={{
        mutationFn: (item) =>
          commands.deleteCustomResource(
            crdName,
            item.name,
            item.namespace || null
          ),
        invalidateQueryKeys: [["custom-resources", crdName]],
        resourceType: crdKind,
      }}
      staleTime={STALE_TIMES.resourceList}
      refetchInterval={watchFailed ? REFRESH_INTERVALS.resourceList : false}
      searchKey="name"
      searchPlaceholder={`Search ${crdKind}...`}
      embedded={embedded}
      getRowHref={getDetailPath}
    />
  );
}

// Helper function to get value from JSON path
function getValueFromJsonPath(
  obj: CustomResourceInfo,
  jsonPath: string
): unknown {
  // Remove leading dot if present
  const path = jsonPath.startsWith(".") ? jsonPath.slice(1) : jsonPath;
  const parts = path.split(".");

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;

    // Handle array notation like [0]
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, key, index] = arrayMatch;
      current = (current as Record<string, unknown>)[key];
      if (Array.isArray(current)) {
        current = current[parseInt(index, 10)];
      }
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

// Helper function to format column value based on type
function formatColumnValue(
  value: unknown,
  columnType: string
): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-fg-fnt">—</span>;
  }

  switch (columnType) {
    case "date":
      if (typeof value === "string") {
        return <RealtimeAge timestamp={value} />;
      }
      return String(value);

    case "integer":
    case "number":
      return (
        <span className="font-mono">
          {typeof value === "number" ? value.toLocaleString() : String(value)}
        </span>
      );

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
      return (
        <span className="max-w-[200px] truncate text-fg-mid">
          {String(value)}
        </span>
      );
  }
}

/** Only render a badge when the string is a state, not free text. */
function isKnownStatus(value: string): boolean {
  return statusRole(value) !== "neutral" || value.toLowerCase() === "unknown";
}
