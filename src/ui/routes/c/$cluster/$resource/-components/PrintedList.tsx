import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { EmptyPage } from "../../../../-components/NotFound";
import { createNamespaceColumn } from "../../-list/columns";
import { ResourceList } from "../../-list/ResourceList";
import { servedOf, useServed } from "../../-object/served";
import { Button } from "@/components/ui/button";
import { RealtimeAge } from "@/components/ui/realtime";
import { RouteLink } from "@/components/ui/route-link";
import type { ColumnDef } from "@/components/ui/table-features";
import type {
  CatalogEntry,
  TableColumn,
  TableRow,
  UnreadNamespace,
} from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { hrefOf, objectLink, type AppLink } from "@/lib/links";
import { scopeCacheKey } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";

type PrintedRow = TableRow & { namespace: string };

interface Printed {
  columns: TableColumn[];
  rows: PrintedRow[];
  unread: UnreadNamespace[];
  more: boolean;
}

/** Pages a "show more" adds: a thousand rows, five IPC answers. */
const PAGES_PER_STEP = 5;
const NO_COLUMNS: TableColumn[] = [];
/** The columns kubectl prints without `-o wide`. */
const DEFAULT_PRIORITY = 0;

/**
 * Any kind the cluster serves, listed as the API server prints it for
 * kubectl. What the catalogue cannot vouch for is said instead of an empty
 * table: a kind that is not served, a discovery nobody could read, a kind
 * that cannot be listed.
 */
export function PrintedList({ resource }: { resource: string }) {
  const t = useT();
  const served = useServed(servedOf(resource));
  if (served.state === "reading") return null;
  if (served.state === "absent")
    return (
      <EmptyPage
        title={t("empty", "notServed", { resource })}
        body={t("empty", "notServedBody")}
      />
    );
  if (served.state === "unknown")
    return (
      <EmptyPage
        title={t("empty", "discoveryUnread", { resource })}
        body={t("empty", "discoveryUnreadBody", { error: served.error })}
      />
    );
  if (!served.entry.verbs.includes("list"))
    return (
      <EmptyPage
        title={t("empty", "notListable", { resource })}
        body={t("empty", "notListableBody")}
      />
    );
  return <PrintedTable resource={resource} entry={served.entry} />;
}

async function readPages(
  entry: CatalogEntry,
  scope: string[] | null,
  pages: number
): Promise<Printed> {
  const printed: Printed = {
    columns: NO_COLUMNS,
    rows: [],
    unread: [],
    more: false,
  };
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const answer = await commands.listResourceTable(
      entry.group,
      entry.plural,
      scope,
      cursor
    );
    if (page === 0) printed.columns = answer.columns;
    for (const row of answer.rows)
      printed.rows.push({ ...row, namespace: row.namespace ?? "" });
    printed.unread.push(...answer.unread);
    cursor = answer.cursor;
    if (!cursor) break;
  }
  printed.more = cursor !== null;
  return printed;
}

function PrintedTable({
  resource,
  entry,
}: {
  resource: string;
  entry: CatalogEntry;
}) {
  const t = useT();
  const scope = useNamespaceScope();
  const isConnected = useClusterStore((state) => state.isConnected);
  const wire = entry.namespaced ? scope.wire : null;
  const cacheKey = entry.namespaced ? scopeCacheKey(scope.scope) : null;
  const [pages, setPages] = useState(1);

  const printed = useLiveQuery({
    queryKey: queryKeys.printedList(entry.group, entry.plural, cacheKey, pages),
    queryFn: () => readPages(entry, wire, pages),
    enabled: isConnected,
    placeholderData: keepPreviousData,
    refresh: "resourceList",
    staleTime: STALE_TIMES.resourceList,
  });

  const linkOf = useMemo(
    () =>
      (row: PrintedRow): AppLink | null =>
        objectLink({
          kind: entry.kind,
          name: row.name,
          namespace: entry.namespaced ? row.namespace : null,
          crd: resource,
        }),
    [entry, resource]
  );
  const showNamespace = entry.namespaced && wire?.length !== 1;
  const serverColumns = printed.data?.columns ?? NO_COLUMNS;
  const columns = useMemo(
    () => columnsOf(serverColumns, showNamespace, linkOf),
    [serverColumns, showNamespace, linkOf]
  );
  const rows = printed.data?.rows;

  return (
    <ResourceList<PrintedRow>
      title={entry.kind}
      description={resource}
      data={rows}
      unread={printed.data?.unread}
      isLoading={printed.isLoading}
      error={printed.error}
      dataUpdatedAt={printed.dataUpdatedAt}
      slowed={printed.freshness.slowed}
      onRetry={() => void printed.refetch()}
      placeholder={printed.isPlaceholderData}
      columns={columns}
      emptyStateLabel={resource}
      widthsKey={`printed:${resource}`}
      narrowingHelps={entry.namespaced}
      getRowId={(row) => row.uid ?? `${row.namespace}/${row.name}`}
      getRowHref={(row) => {
        const link = linkOf(row);
        return link ? hrefOf(link) : "";
      }}
      headerContent={
        printed.data?.more ? (
          <div className="flex items-center gap-3 text-sm text-fg-mut">
            <span>
              {t("empty", "printedMore", { count: rows?.length ?? 0 })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={printed.isPlaceholderData}
              onClick={() => setPages((n) => n + PAGES_PER_STEP)}
            >
              {t("empty", "showMore")}
            </Button>
          </div>
        ) : null
      }
    />
  );
}

/**
 * The server's columns, drawn by the type it declares. The `name` column is
 * the row's link; a `date` is an age, as kubectl prints it.
 */
function columnsOf(
  printed: TableColumn[],
  showNamespace: boolean,
  linkOf: (row: PrintedRow) => AppLink | null
): ColumnDef<PrintedRow>[] {
  const columns: ColumnDef<PrintedRow>[] = [];
  printed.forEach((column, index) => {
    if (column.priority > DEFAULT_PRIORITY) return;
    columns.push({
      id: `printed-${index}`,
      size: column.format === "name" ? 320 : 140,
      header: column.name,
      accessorFn: (row) => row.cells[index],
      cell: ({ row }) => (
        <Cell
          value={row.original.cells[index]}
          column={column}
          link={column.format === "name" ? linkOf(row.original) : null}
        />
      ),
    });
    if (column.format === "name" && showNamespace)
      columns.push(createNamespaceColumn<PrintedRow>());
  });
  return columns;
}

function Cell({
  value,
  column,
  link,
}: {
  value: unknown;
  column: TableColumn;
  link: AppLink | null;
}) {
  if (value === null || value === undefined || value === "")
    return <span className="text-fg-fnt">—</span>;
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (link)
    return (
      <RouteLink {...link} className="font-mono text-info hover:underline">
        {text}
      </RouteLink>
    );
  if (column.columnType === "date")
    return (
      <span className="text-fg-fnt">
        <RealtimeAge timestamp={text} />
      </span>
    );
  if (column.columnType === "integer" || column.columnType === "number")
    return <span className="tabular-nums">{text}</span>;
  return <span>{text}</span>;
}
