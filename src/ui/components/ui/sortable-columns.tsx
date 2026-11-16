import type { HeaderSaying } from "@/i18n/column-header";
import type { ColumnDef, RowData } from "@/components/ui/table-features";
import type { AppColumnMeta } from "@/components/ui/table-features";
import { SortableHeader } from "@/components/ui/sortable-header";

type Sorted = ColumnDef<never>;

const made = new WeakMap<object, Sorted>();

function compare(
  a: string | number | boolean | null | undefined,
  b: string | number | boolean | null | undefined
) {
  if (typeof a === "string" && typeof b === "string")
    return a.localeCompare(b, undefined, { numeric: true });
  return Number(a) - Number(b);
}

/**
 * The column, sortable when it can be: a header drawn by `columnHeader` becomes
 * a sort control, and a column with no value of its own sorts by `meta.sort`.
 * One that has neither is returned as it came, because a header that offered
 * to sort and did nothing is worse than none.
 */
export function sortableColumn<Row extends RowData>(
  column: ColumnDef<Row>
): ColumnDef<Row> {
  const cached = made.get(column);
  if (cached) return cached as unknown as ColumnDef<Row>;
  const next = build(column);
  made.set(column, next as unknown as Sorted);
  return next;
}

function build<Row extends RowData>(column: ColumnDef<Row>): ColumnDef<Row> {
  const saying = (column.header as { saying?: HeaderSaying } | undefined)
    ?.saying;
  if (column.enableSorting === false || saying?.section !== "columns")
    return column;
  const meta = column.meta as AppColumnMeta | undefined;
  const own = "accessorKey" in column || "accessorFn" in column;
  const sort = meta?.sort as
    | ((row: Row) => ReturnType<NonNullable<AppColumnMeta["sort"]>>)
    | undefined;
  if (!own && !sort) return column;

  const header = ({
    column: sorted,
  }: {
    column: Parameters<typeof SortableHeader>[0]["column"];
  }) => (
    <SortableHeader
      column={sorted}
      k={saying.key as Parameters<typeof SortableHeader>[0]["k"]}
    />
  );
  const base = {
    ...column,
    header,
    sortUndefined: column.sortUndefined ?? "last",
    meta: { ...meta, label: meta?.label ?? saying },
  } as ColumnDef<Row>;
  if (!sort) return base;
  const id = column.id ?? (column as { accessorKey?: string }).accessorKey;
  const ordered = (row: Row) => sort(row) ?? undefined;
  return own
    ? ({
        ...base,
        sortFn: (a: { original: Row }, b: { original: Row }) =>
          compare(sort(a.original), sort(b.original)),
      } as ColumnDef<Row>)
    : ({
        ...base,
        id,
        accessorFn: ordered,
        enableGlobalFilter: false,
        meta: { ...base.meta, sortOnly: true },
      } as ColumnDef<Row>);
}
