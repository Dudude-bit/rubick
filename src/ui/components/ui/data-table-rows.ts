import type { ReactNode } from "react";
import type { Row, RowData } from "./table-features";
import type { RowGrouping } from "./row-grouping";

/**
 * One entry per line the table draws, captions included.
 *
 * Descriptors rather than rendered nodes: the virtualiser needs to count and
 * measure the lines before anything decides which of them to draw.
 */
export type BodyItem<TData extends RowData> =
  | { key: string; caption: ReactNode; row?: undefined }
  | { key: string; caption?: undefined; row: Row<TData>; rowIndex: number };

export function buildTableRows<TData extends RowData>(
  rows: Row<TData>[],
  grouping: RowGrouping<TData> | null
) {
  // One caption per group, rows beneath it in first-seen order. Flat, so the
  // keyboard-nav index stays the visual position and does not skip captions.
  const items: BodyItem<TData>[] = [];
  // Where each data row sits among those lines. The two numberings come apart
  // wherever a caption is inserted, and the virtualiser counts lines while the
  // keyboard counts rows.
  const rowLine: number[] = [];
  const pushRow = (row: Row<TData>, rowIndex: number) => {
    rowLine[rowIndex] = items.length;
    items.push({ key: row.id, row, rowIndex });
  };

  if (grouping) {
    const groups = new Map<string, Row<TData>[]>();
    const ungrouped: Row<TData>[] = [];
    for (const row of rows) {
      const key = grouping.keyOf(row.original);
      if (key === null) {
        ungrouped.push(row);
        continue;
      }
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    let index = 0;
    // No caption over these: the data did not say which group they are in,
    // and a heading reading "ungrouped" would turn that silence into a claim.
    for (const row of ungrouped) pushRow(row, index++);
    for (const [key, groupRows] of groups) {
      items.push({
        key: `group-${key}`,
        caption: grouping.caption(
          key,
          groupRows.map((row) => row.original)
        ),
      });
      for (const row of groupRows) pushRow(row, index++);
    }
  } else {
    rows.forEach((row, index) => pushRow(row, index));
  }

  return { items, rowLine };
}
