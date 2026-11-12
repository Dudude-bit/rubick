import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { EmptyPage } from "../../../../-components/NotFound";
import { AgeHeader } from "@/components/ui/sortable-header";
import {
  AGE_LABEL,
  ageOrder,
  createNamespaceColumn,
  nameCellPx,
} from "../../-list/columns";
import type { Catalogue } from "@/i18n/catalogue";
import { widestText } from "@/lib/text-width";
import { withoutCredentials } from "@/lib/hints";
import { ResourceList } from "../../-list/ResourceList";
import { servedOf, useServed } from "../../-object/served";
import { Unserved } from "../../-object/Unserved";
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
import { hrefOf, objectLink, registryKindOf } from "@/lib/links";
import { scopeCacheKey } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";
import { tabRouteLabel } from "@/stores/scopeTabStore";
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
/** Columns the API server prints, named in the reader's language where they are words and not fields. */
const STANDARD_HEADERS: Partial<Record<string, keyof Catalogue["columns"]>> = {
  Name: "name",
  Age: "age",
  "Created At": "created",
  Role: "role",
  Status: "status",
  Ready: "ready",
  Type: "type",
  Data: "data",
  Value: "value",
  Groups: "groups",
  Replicas: "replicas",
  Targets: "targets",
  Reference: "printedReference",
  MinPods: "printedMinPods",
  MaxPods: "printedMaxPods",
  "Min Available": "printedMinAvailable",
  "Max Unavailable": "printedMaxUnavailable",
  "Allowed Disruptions": "printedAllowedDisruptions",
};
/** A text column holds its longest value whole up to here, and past it cuts. */
const TEXT_FLOOR_PX = 240;
/** How the server describes a column that reads `metadata.creationTimestamp`. */
const CREATION = /creationTimestamp/i;

const isAge = (column: TableColumn) =>
  CREATION.test(column.description) || column.columnType === "date";

const cellText = (value: unknown) =>
  value === null || value === undefined
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

/** The widest value a text column holds, as the floor it is not drawn under. */
const textFloor =
  (index: number) => (_t: unknown, rows: readonly PrintedRow[]) =>
    Math.min(
      TEXT_FLOOR_PX,
      widestText(
        rows.map((row) => cellText(row.cells[index])),
        "sans",
        7.2
      ) + 20
    );

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
export function PrintedList({
  resource,
  reading = false,
}: {
  resource: string;
  /** Whether the address is a CRD's is still being read, so nothing is said of it yet. */
  reading?: boolean;
}) {
  const t = useT();
  const served = useServed(servedOf(resource));
  if (reading || served.state === "reading")
    return <ReadingKinds resource={resource} />;
  if (served.state === "absent" || served.state === "unknown")
    return <Unserved served={served} resource={resource} />;
  if (!served.entry.verbs.includes("list"))
    return (
      <EmptyPage
        title={t("empty", "notListable", { resource })}
        body={t("empty", "notListableBody")}
      />
    );
  // Keyed by the kind: the table holds the last answer while the next is
  // read, which is for a change of scope. Another kind's rows held under this
  // one would each link, peek and delete as an object of this kind.
  return (
    <PrintedTable key={resource} resource={resource} entry={served.entry} />
  );
}

const NO_PRINTED_COLUMNS: ColumnDef<PrintedRow>[] = [];

/**
 * The list as every list waits, while discovery says what the address names:
 * a wedged API group holds the catalogue for seconds, and the pane was blank
 * for all of them. The picker is not offered: discovery has no namespace.
 */
function ReadingKinds({ resource }: { resource: string }) {
  const t = useT();
  const [since] = useState(() => Date.now());
  // The tab's own name for the page, until discovery has a better one.
  const title = tabRouteLabel(resource, t);
  return (
    <ResourceList<PrintedRow>
      title={title}
      kind={null}
      isLoading
      waitingSince={since}
      narrowingHelps={false}
      columns={NO_PRINTED_COLUMNS}
      emptyStateLabel={title}
    />
  );
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
  const plural = listTitleOf(entry);
  const noun = useMemo(
    () => ({ kind: entry.kind, plural }),
    [entry.kind, plural]
  );

  return (
    <ResourceList<PrintedRow>
      title={plural}
      kind={registryKindOf(entry)}
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
      more={printed.data?.more}
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
  const shown = printed.filter((column) => column.priority <= DEFAULT_PRIORITY);
  printed.forEach((column, index) => {
    if (column.priority > DEFAULT_PRIORITY) return;
    const standard = STANDARD_HEADERS[column.name];
    const byAge = standard === "age" && CREATION.test(column.description);
    const named = column.format === "name";
    const text =
      !named &&
      !isAge(column) &&
      column.columnType !== "integer" &&
      column.columnType !== "number";
    // The name stays; kubectl's later columns give way first.
    const yields = named ? undefined : shown.length - shown.indexOf(column);
    columns.push({
      id: `printed-${index}`,
      size: sizeOf(column),
      meta: {
        floor: named ? nameCellPx : text ? textFloor(index) : undefined,
        yields,
        ...(byAge ? { label: AGE_LABEL } : {}),
      },
      ...(byAge
        ? {
            header: AgeHeader,
            accessorFn: (row: PrintedRow) => ageOrder(row.createdAt),
            sortUndefined: "last" as const,
            sortDescFirst: false,
            enableGlobalFilter: false,
          }
        : {
            header: standard ? columnHeader("columns", standard) : column.name,
            accessorFn: (row: PrintedRow) => row.cells[index],
          }),
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
  // A printed column is a path into the object, and an address is one.
  const text = withoutCredentials(
    typeof value === "object" ? JSON.stringify(value) : String(value)
  );
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
