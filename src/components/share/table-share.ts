import { Table2 } from "lucide-react";

import type { AppColumnMeta } from "@/components/ui/table-features";
import type { HeaderSaying } from "@/i18n/column-header";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, refOf, slugOf, type PlacedSection } from "@/lib/report-parts";
import { statusRole } from "@/lib/status-role";

/** A table in a file is read, not scrolled: past this the app is the place. */
const MAX_ROWS = 300;

/** Controls, not facts. */
const CONTROLS = new Set(["select", "actions", "__actions", "quickActions"]);

/** Drawn from the row itself, in a form of their own: the name as the object, the age as a time. */
const OWN = new Set(["name", "namespace", "age", "createdAt"]);

interface Column {
  id: string;
  columnDef: {
    header?: unknown;
    meta?: unknown;
    accessorKey?: unknown;
    accessorFn?: unknown;
  };
}
interface Cell {
  column: Column;
  getValue: () => unknown;
}
interface Row {
  original: unknown;
  getVisibleCells: () => Cell[];
}
interface ShareableTable {
  getRowModel: () => { rows: Row[] };
  getVisibleFlatColumns: () => Column[];
}

/** The table a list that could not be read does not have. */
export const NO_TABLE: ShareableTable = {
  getRowModel: () => ({ rows: [] }),
  getVisibleFlatColumns: () => [],
};

export interface TableShare {
  title: string;
  /** The kind every row is, so its name is drawn as that object. */
  kind?: string | null;
  /** Why nothing could be read: the file says so in place of rows. */
  unread?: string | null;
  /** Why the rows are not the whole scope, when some of it was read. */
  partial?: string | null;
  /** What the list's search box holds: the rows are only the ones matching it. */
  search?: string;
}

/** The header in the reader's language, or `null` where the app never names it in words. */
function headerOf(column: Column, t: T): string | null {
  const header = column.columnDef.header as
    { saying?: HeaderSaying } | string | undefined;
  if (typeof header === "string") return header;
  const saying =
    header?.saying ??
    (column.columnDef.meta as AppColumnMeta | undefined)?.label;
  if (!saying) return null;
  return (t as unknown as (section: string, key: string) => string)(
    saying.section,
    saying.key
  );
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(", ");
  const object = value as { display?: unknown; name?: unknown };
  if (typeof object.display === "string") return object.display;
  if (typeof object.name === "string") return object.name;
  return "";
}

/**
 * The status a list without a `share` on its status column carries on the
 * row. A list that draws its status from anything else says so on the
 * column, because this cannot know.
 */
function statusOf(original: unknown): string | null {
  const row = original as {
    status?: unknown;
    phase?: unknown;
  } | null;
  const status = row?.status as
    { display?: unknown; phase?: unknown } | string | undefined;
  if (typeof status === "string" && status) return status;
  if (status && typeof status === "object") {
    if (typeof status.display === "string") return status.display;
    if (typeof status.phase === "string") return status.phase;
  }
  if (typeof row?.phase === "string") return row.phase;
  return null;
}

/** `Date.parse` also takes "110" and "1.2.3", which are versions and ports. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function isoOf(value: unknown): string | null {
  return typeof value === "string" &&
    ISO_TIME.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function valueOf(
  column: Column,
  cell: Cell | undefined,
  original: unknown,
  t: T
): ReportValue {
  const share = (column.columnDef.meta as AppColumnMeta | undefined)?.share;
  if (share) {
    const said = share(original as never, t);
    if (said === null) return { text: "" };
    if (typeof said !== "string") return said;
    return column.id === "status"
      ? { text: said, role: statusRole(said) }
      : { text: said, mono: /^\d/.test(said) };
  }
  if (column.id === "status") {
    const status = statusOf(original);
    return status ? { text: status, role: statusRole(status) } : { text: "" };
  }
  const value = cell?.getValue();
  const time = isoOf(value);
  const text = textOf(value);
  return time ? { text, at: time } : { text, mono: /^\d/.test(text) };
}

/**
 * The rows as the table draws them right now: searched, sorted, only the
 * visible columns, each in the words its cell draws. A column that cannot
 * say what it draws is named as left out rather than dropped in silence, and
 * a list that was not read, or not all of it, says so.
 */
export function tableSection(
  table: ShareableTable,
  share: TableShare,
  t: T
): PlacedSection {
  const shell = {
    id: `table-${slugOf(share.title)}`,
    order: ORDER.own,
    title: share.title,
    icon: iconSvg(Table2),
  };
  if (share.unread)
    return {
      ...shell,
      count: null,
      unread: share.unread,
      body: { type: "table", columns: [], rows: [], more: null },
    };

  const rows = table.getRowModel().rows;
  const kept = rows.slice(0, MAX_ROWS);
  const originals = kept.map(
    (row) =>
      row.original as {
        name?: unknown;
        namespace?: unknown;
        createdAt?: unknown;
      } | null
  );
  const named = originals.some((row) => typeof row?.name === "string");
  const aged = originals.some((row) => isoOf(row?.createdAt) !== null);

  const facts = table
    .getVisibleFlatColumns()
    .filter((column) => !CONTROLS.has(column.id) && !OWN.has(column.id));
  const cellsOf = kept.map(
    (row) =>
      new Map(row.getVisibleCells().map((cell) => [cell.column.id, cell]))
  );
  const values = facts.map((column) =>
    kept.map((row, index) =>
      valueOf(column, cellsOf[index].get(column.id), row.original, t)
    )
  );
  // A column says what it draws through `share`, or through a value the
  // file can put in words; one that does neither cannot be carried, and the
  // reader is told so rather than left to think the screen never had it.
  const speaks = facts.map((column) => {
    const def = column.columnDef;
    if (
      (def.meta as AppColumnMeta | undefined)?.share ||
      column.id === "status"
    )
      return true;
    if (!def.accessorKey && !def.accessorFn) return false;
    return cellsOf.every((cells) => {
      const value = cells.get(column.id)?.getValue();
      return value === null || value === undefined || textOf(value) !== "";
    });
  });
  const said = facts.flatMap((column, index) => {
    const header = headerOf(column, t);
    return header !== null &&
      speaks[index] &&
      values[index].some((value) => value.text)
      ? [{ header, values: values[index] }]
      : [];
  });
  const leftOut = facts.flatMap((column, index) => {
    const header = headerOf(column, t);
    return header !== null && !speaks[index] ? [header] : [];
  });

  const nameCell = (original: (typeof originals)[number]): ReportValue => {
    const name = typeof original?.name === "string" ? original.name : "";
    return share.kind && name
      ? {
          text: name,
          ref: refOf({
            kind: share.kind,
            name,
            namespace:
              typeof original?.namespace === "string"
                ? original.namespace
                : null,
          }),
        }
      : { text: name, mono: true };
  };

  const search = share.search?.trim();
  const notes = [
    search ? t("share", "tableSearched", { query: search }) : null,
    leftOut.length > 0
      ? t("share", "columnsLeftOut", { names: leftOut.join(", ") })
      : null,
  ].filter((note): note is string => note !== null);

  return {
    ...shell,
    count: share.partial ? null : rows.length,
    partial: share.partial ?? null,
    caption: notes.length > 0 ? notes.join(" ") : null,
    body: {
      type: "table",
      columns: [
        ...(named ? [t("columns", "name")] : []),
        ...said.map((column) => column.header),
        ...(aged ? [t("share", "created")] : []),
      ],
      rows: originals.map((original, index) => {
        const at = isoOf(original?.createdAt);
        return {
          cells: [
            ...(named ? [nameCell(original)] : []),
            ...said.map((column) => column.values[index]),
            ...(aged ? [at ? { text: at, at } : { text: "" }] : []),
          ],
        };
      }),
      more:
        rows.length > kept.length
          ? t("share", "rowsMore", { n: rows.length - kept.length })
          : null,
    },
  };
}
