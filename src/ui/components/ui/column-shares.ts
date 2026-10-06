/** A column as the layout sees it: its size in units, and the pixels it never goes under. */
export interface ColumnSpec {
  size: number;
  floor?: number;
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
