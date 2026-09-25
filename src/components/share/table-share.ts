import { Table2 } from "lucide-react";

import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, refOf, slugOf, type PlacedSection } from "@/lib/report-parts";
import { statusRole } from "@/lib/status-role";

/** A table in a file is read, not scrolled: past this the app is the place. */
const MAX_ROWS = 300;

/** Columns that are controls, or that the row itself answers better. */
const SKIPPED = new Set([
  "select",
  "actions",
  "__actions",
  "quickActions",
  "name",
  "namespace",
  "status",
  "age",
  "createdAt",
]);

interface Column {
  id: string;
  columnDef: { header?: unknown; meta?: unknown };
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

export interface TableShare {
  title: string;
  /** The kind every row is, so its name is drawn as that object. */
  kind?: string | null;
}

/** `lastTransitionTime` → `Last transition time`: a column id is all a rendered header leaves. */
function headerOf(column: Column): string {
  const meta = column.columnDef.meta as { label?: unknown } | undefined;
  if (typeof meta?.label === "string") return meta.label;
  if (typeof column.columnDef.header === "string")
    return column.columnDef.header;
  const words = column.id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
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

/** The status every list draws in its own way, read off the row itself. */
function statusOf(original: unknown): string | null {
  const row = original as {
    status?: unknown;
    phase?: unknown;
  } | null;
  const status = row?.status as
    | { display?: unknown; ready?: unknown; phase?: unknown }
    | string
    | undefined;
  if (typeof status === "string" && status) return status;
  if (status && typeof status === "object") {
    if (typeof status.display === "string") return status.display;
    if (typeof status.phase === "string") return status.phase;
    if (typeof status.ready === "boolean")
      return status.ready ? "Ready" : "NotReady";
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

/**
 * The rows as the table draws them right now: searched, sorted, only the
 * visible columns. The name, status and age come from the row, because every
 * list draws those with its own component; the rest are the column values,
 * and a column the app renders from the row rather than from a value has no
 * words to give and is left out rather than guessed at.
 */
export function tableSection(
  table: ShareableTable,
  share: TableShare,
  t: T
): PlacedSection {
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
  const statused = originals.some((row) => statusOf(row) !== null);
  const aged = originals.some((row) => isoOf(row?.createdAt) !== null);
  const columns = table
    .getVisibleFlatColumns()
    .filter((column) => !SKIPPED.has(column.id))
    .filter((column) =>
      kept.some((row) =>
        row
          .getVisibleCells()
          .some(
            (cell) => cell.column.id === column.id && textOf(cell.getValue())
          )
      )
    );

  const cells = (row: Row, index: number): ReportValue[] => {
    const original = originals[index];
    const out: ReportValue[] = [];
    if (named) {
      const name = typeof original?.name === "string" ? original.name : "";
      out.push(
        share.kind && name
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
          : { text: name, mono: true }
      );
    }
    if (statused) {
      const status = statusOf(original) ?? "";
      out.push(
        status ? { text: status, role: statusRole(status) } : { text: "" }
      );
    }
    const byColumn = new Map(
      row.getVisibleCells().map((cell) => [cell.column.id, cell] as const)
    );
    for (const column of columns) {
      const value = byColumn.get(column.id)?.getValue();
      const time = isoOf(value);
      const text = textOf(value);
      out.push(time ? { text, at: time } : { text, mono: /^\d/.test(text) });
    }
    if (aged) {
      const at = isoOf(original?.createdAt);
      out.push(at ? { text: at, at } : { text: "" });
    }
    return out;
  };

  return {
    id: `table-${slugOf(share.title)}`,
    order: ORDER.own,
    title: share.title,
    icon: iconSvg(Table2),
    count: rows.length,
    body: {
      type: "table",
      columns: [
        ...(named ? [t("columns", "name")] : []),
        ...(statused ? [t("columns", "status")] : []),
        ...columns.map(headerOf),
        ...(aged ? [t("share", "created")] : []),
      ],
      rows: kept.map((row, index) => ({ cells: cells(row, index) })),
      more:
        rows.length > kept.length
          ? t("share", "rowsMore", { n: rows.length - kept.length })
          : null,
    },
  };
}
