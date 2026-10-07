import type { AppColumnMeta } from "@/components/ui/table-features";
import type { HeaderSaying } from "@/i18n/column-header";
import type { T } from "@/i18n/useT";

interface LabelledColumn {
  header?: unknown;
  meta?: unknown;
}

/** A column's header in the reader's language, or `null` where it has no words. */
export function columnLabel(column: LabelledColumn, t: T): string | null {
  const header = column.header as
    | { saying?: HeaderSaying }
    | string
    | undefined;
  if (typeof header === "string") return header;
  const saying =
    header?.saying ?? (column.meta as AppColumnMeta | undefined)?.label;
  if (!saying) return null;
  return (t as unknown as (section: string, key: string) => string)(
    saying.section,
    saying.key
  );
}

/** 11px medium glyphs, generously, so a label is never measured short. */
const GLYPH_PX = 7;
/** A sort control's 12px mark, its 4px gap and the button's own 8px of padding. */
const SORT_MARK_PX = 24;
/** The header cell's own padding. */
const PADDING_PX = 20;

/**
 * The narrowest a column can be drawn with its header whole. "Готовность",
 * "Перезапуски" and "Возраст" were cut on a Pods table with room to spare.
 */
export function headerFloor(column: LabelledColumn, t: T): number {
  const label = columnLabel(column, t);
  if (!label) return 0;
  const sortable = (column.meta as AppColumnMeta | undefined)?.label;
  return Math.ceil(
    label.length * GLYPH_PX + (sortable ? SORT_MARK_PX : 0) + PADDING_PX
  );
}
