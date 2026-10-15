/** WebKitGTK's overlay scrollbar takes the pointer over a port's last 21px. */
export const SCROLLBAR_REACH = 24;
export const ACTIONS_CELL_GUTTER = { paddingRight: SCROLLBAR_REACH };
/** A cell's own padding on either side. */
export const CELL_PAD_PX = 10;

/**
 * The width the actions cell needs, from what it actually holds: a 20px icon
 * and a 2px gap each, the cell's own 10px padding on the left and `gutter` on
 * the right, the overlay scrollbar's reach unless the port draws its own in a
 * lane. TanStack's default is 150, a name column's worth of the table
 * reserved for two buttons, on every list in the app.
 */
export const actionsColumnSize = (count: number, gutter = SCROLLBAR_REACH) =>
  CELL_PAD_PX + gutter + count * 22;

/** A column as the layout sees it: its size in units, and the pixels it never goes under. */
export interface ColumnSpec {
  size: number;
  floor?: number;
  /** A higher floor it rises to with the room the floors leave, before any column grows past its own. */
  ideal?: number;
  /** Holds controls, not text: drawn at its floor while the table scrolls. */
  fixed?: boolean;
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
  const span = port > 0 ? Math.max(port, floors) : 0;
  if (span > port) return scrolledToEnd(columns, port);
  return {
    span,
    scrolls: false,
    shares: columnShares(towardIdeals(columns, port - floors), span),
  };
}

/** Every floor raised toward its ideal by the same part of the way, as far as `room` takes them all. */
function towardIdeals(columns: ColumnSpec[], room: number): ColumnSpec[] {
  const rise = columns.map((column) =>
    Math.max(0, (column.ideal ?? 0) - (column.floor ?? 0))
  );
  const wanted = rise.reduce((sum, px) => sum + px, 0);
  if (wanted === 0 || room <= 0) return columns;
  const part = Math.min(1, room / wanted);
  return columns.map((column, index) => ({
    ...column,
    floor: (column.floor ?? 0) + rise[index] * part,
  }));
}

/** What a column shows of itself beside the pinned one, past which it reads as text and not as a stray glyph. */
const SLIVER_PX = 64;

/**
 * A table wider than its port, every column at its floor. Scrolled to the
 * end, the column before the last ones that fit beside the pinned first one
 * showed a sliver: a stray ")" of a restart count, "a…" of a message. Where
 * less than half of it shows, and under {@link SLIVER_PX}, the last columns
 * take that width instead and the column is wholly under the pinned one.
 */
function scrolledToEnd(columns: ColumnSpec[], port: number) {
  const widths = columns.map((column) => column.floor ?? 0);
  const room = port - widths[0];
  let start = widths.length;
  let tail = 0;
  while (start > 1 && tail + widths[start - 1] <= room) {
    start -= 1;
    tail += widths[start];
  }
  const sliver = room - tail;
  const ends = widths.slice(start).map((_, at) => start + at);
  const takers = ends.filter((index) => !columns[index].fixed);
  const growing = takers.length > 0 ? takers : ends;
  const sizes = growing.reduce((sum, index) => sum + columns[index].size, 0);
  if (
    start > 1 &&
    sliver > 0 &&
    sliver < Math.min(SLIVER_PX, widths[start - 1] / 2)
  ) {
    let left = sliver;
    growing.forEach((index, at) => {
      const own =
        at === growing.length - 1
          ? left
          : Math.floor(
              sizes > 0
                ? (sliver * columns[index].size) / sizes
                : sliver / growing.length
            );
      widths[index] += own;
      left -= own;
    });
  }
  const span = widths.reduce((sum, width) => sum + width, 0);
  return {
    span,
    scrolls: true,
    shares: widths.map((width) => (width / span) * 100),
  };
}

/** A column as the narrow port sees it: its id, its floor and where it gives way. */
export interface YieldSpec {
  id: string;
  floor: number;
  yields?: number;
}

/**
 * The columns a port `port` pixels wide hides so the rest fit at their
 * floors: the lowest `yields` first, only as many as it takes, none where
 * no column yields or the port is not measured yet.
 */
export function yieldedColumns(columns: YieldSpec[], port: number): string[] {
  if (port <= 0) return [];
  let total = columns.reduce((sum, column) => sum + column.floor, 0);
  const hidden: string[] = [];
  const order = columns
    .filter((column) => column.yields !== undefined)
    .sort((a, b) => a.yields! - b.yields!);
  for (const column of order) {
    if (total <= port) break;
    total -= column.floor;
    hidden.push(column.id);
  }
  return hidden;
}
