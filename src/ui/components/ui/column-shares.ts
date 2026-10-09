/** WebKitGTK's overlay scrollbar takes the pointer over a port's last 21px. */
export const SCROLLBAR_REACH = 24;
export const ACTIONS_CELL_GUTTER = { paddingRight: SCROLLBAR_REACH };

/**
 * The width the actions cell needs, from what it actually holds: a 20px icon
 * and a 2px gap each, the cell's own 10px padding on the left and the
 * scrollbar's reach on the right. TanStack's default is 150, a name column's
 * worth of the table reserved for two buttons, on every list in the app.
 */
export const actionsColumnSize = (count: number) =>
  10 + SCROLLBAR_REACH + count * 22;

/** A column as the layout sees it: its size in units, and the pixels it never goes under. */
export interface ColumnSpec {
  size: number;
  floor?: number;
  /** A higher floor it keeps while every column's fits the port. */
  ideal?: number;
}

/**
 * Each column's share of the table, in per cent. A share is `size / total`
 * until the table is measured; after that a column with a floor that its
 * share would draw narrower is pinned at the floor, and the others split
 * what is left in proportion to their sizes.
 */
export function columnShares(columns: ColumnSpec[], width: number): number[] {
  const total = columns.reduce((sum, column) => sum + column.size, 0);
  if (total <= 0) return columns.map(() => 0);
  if (width <= 0) return columns.map((column) => (column.size / total) * 100);

  const pinned = new Set<number>();
  for (;;) {
    let freeSize = 0;
    let freeWidth = width;
    columns.forEach((column, index) => {
      if (pinned.has(index)) freeWidth -= column.floor ?? 0;
      else freeSize += column.size;
    });
    const scale = freeSize > 0 ? Math.max(freeWidth, 0) / freeSize : 0;
    const before = pinned.size;
    columns.forEach((column, index) => {
      if (!pinned.has(index) && column.size * scale < (column.floor ?? 0)) {
        pinned.add(index);
      }
    });
    if (pinned.size === before) {
      return columns.map((column, index) => {
        const px = pinned.has(index)
          ? (column.floor ?? 0)
          : column.size * scale;
        return (px / width) * 100;
      });
    }
  }
}

/**
 * How a table is laid out in a port `port` pixels wide. The shares are of the
 * table's own width, which is the port's unless the floors add up to more:
 * then the table is as wide as they are and the port scrolls, because a
 * share of a table that cannot be wider than its port is a cut.
 */
export function tableLayout(columns: ColumnSpec[], port: number) {
  const floors = columns.reduce((sum, column) => sum + (column.floor ?? 0), 0);
  const ideal = columns.map((column) =>
    Math.max(column.floor ?? 0, column.ideal ?? 0)
  );
  const roomy = ideal.reduce((sum, px) => sum + px, 0) <= port;
  const span = port > 0 ? Math.max(port, floors) : 0;
  return {
    span,
    scrolls: span > port,
    shares: columnShares(
      roomy
        ? columns.map((column, index) => ({ ...column, floor: ideal[index] }))
        : columns,
      span
    ),
  };
}
