import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { EmptyPage } from "../../../../-components/NotFound";
import { createNamespaceColumn } from "../../-list/columns";
import { ResourceList } from "../../-list/ResourceList";
import { servedOf, useServed } from "../../-object/served";
import { Button } from "@/components/ui/button";
import { RealtimeAge } from "@/components/ui/realtime";
import { ObjectLink } from "@/components/object/ResourceRef";
import type { ColumnDef } from "@/components/ui/table-features";
import type {
  CatalogEntry,
  TableColumn,
  TableRow,
  UnreadNamespace,
} from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import type { PeekTarget } from "@/hooks/usePeek";
import { useT } from "@/i18n/useT";
import { columnHeader } from "@/i18n/column-header";
import { KindAbout } from "@/components/object/KindAbout";
import { accessKind, listTitleOf, segmentOf } from "@/lib/access-kinds";
import { isExplained } from "@/lib/docs";
import { commands } from "@/lib/commands";
import { hrefOf, objectLink } from "@/lib/links";
import { scopeCacheKey } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { kindPlural } from "@/lib/resource-registry";
import { STALE_TIMES } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";
import { None } from "@/components/ui/none";

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
/** The columns the API server prints for every kind, named in the reader's language. */
const STANDARD_HEADERS: Partial<
  Record<string, "name" | "age" | "created" | "role">
> = {
  Name: "name",
  Age: "age",
  "Created At": "created",
  Role: "role",
};
/** How the server describes a column that reads `metadata.creationTimestamp`. */
const CREATION = /creationTimestamp/i;

const isAge = (column: TableColumn) =>
  CREATION.test(column.description) || column.columnType === "date";

/** An age or a count needs a few characters; a RoleBinding's Role needs the rest. */
function sizeOf(column: TableColumn): number {
  if (column.format === "name") return 320;
  if (isAge(column)) return 80;
  if (column.columnType === "integer" || column.columnType === "number")
    return 90;
  return 220;
}

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

  const targetOf = useMemo(
    () =>
      (row: PrintedRow): PeekTarget => ({
        kind: entry.kind,
        name: row.name,
        namespace: entry.namespaced ? row.namespace : null,
        crd: segmentOf(entry),
      }),
    [entry]
  );
  const showNamespace = entry.namespaced && wire?.length !== 1;
  const serverColumns = printed.data?.columns ?? NO_COLUMNS;
  const columns = useMemo(
    () => columnsOf(serverColumns, showNamespace, targetOf),
    [serverColumns, showNamespace, targetOf]
  );
  const rows = printed.data?.rows;
  const access = accessKind(entry.kind);
  const plural =
    access?.group === entry.group
      ? access.displayPlural
      : kindPlural(entry.kind, entry.plural);
  const noun = useMemo(
    () => ({ kind: entry.kind, plural }),
    [entry.kind, plural]
  );

  return (
    <ResourceList<PrintedRow>
      title={listTitleOf(entry)}
      description={
        isExplained(entry.kind) && access?.group === entry.group ? (
          <KindAbout kind={entry.kind} />
        ) : undefined
      }
      noun={noun}
      data={rows}
      unread={printed.data?.unread}
      isLoading={printed.isLoading}
      error={printed.error}
      dataUpdatedAt={printed.dataUpdatedAt}
      slowed={printed.freshness.slowed}
      onRetry={() => void printed.refetch()}
      placeholder={printed.isPlaceholderData}
      columns={columns}
      emptyStateLabel={plural}
      widthsKey={`printed:${resource}`}
      narrowingHelps={entry.namespaced}
      listQuery={{
        group: entry.group,
        resource: entry.plural,
        namespaced: entry.namespaced,
      }}
      getRowId={(row) => row.uid ?? `${row.namespace}/${row.name}`}
      getRowHref={(row) => {
        const link = objectLink(targetOf(row));
        return link ? hrefOf(link) : "";
      }}
      getRowPeek={targetOf}
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
  targetOf: (row: PrintedRow) => PeekTarget
): ColumnDef<PrintedRow>[] {
  const columns: ColumnDef<PrintedRow>[] = [];
  printed.forEach((column, index) => {
    if (column.priority > DEFAULT_PRIORITY) return;
    const standard = STANDARD_HEADERS[column.name];
    columns.push({
      id: `printed-${index}`,
      size: sizeOf(column),
      header: standard ? columnHeader("columns", standard) : column.name,
      accessorFn: (row) => row.cells[index],
      cell: ({ row }) => (
        <Cell
          value={row.original.cells[index]}
          column={column}
          target={column.format === "name" ? targetOf(row.original) : null}
          createdAt={row.original.createdAt}
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
  target,
  createdAt,
}: {
  value: unknown;
  column: TableColumn;
  target: PeekTarget | null;
  createdAt: string | null;
}) {
  if (value === null || value === undefined || value === "") return <None />;
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (target)
    return (
      <ObjectLink {...target} className="font-mono text-info hover:underline">
        {text}
      </ObjectLink>
    );
  // The server's own Age is an English duration ("8m38s"), typed "string".
  const at = CREATION.test(column.description)
    ? createdAt
    : column.columnType === "date" && !Number.isNaN(Date.parse(text))
      ? text
      : null;
  if (at)
    return (
      <span className="text-fg-fnt">
        <RealtimeAge timestamp={at} />
      </span>
    );
  if (column.columnType === "date")
    return <span className="text-fg-fnt">{text}</span>;
  if (column.columnType === "integer" || column.columnType === "number")
    return <span className="tabular-nums">{text}</span>;
  return <span title={text}>{text}</span>;
}
