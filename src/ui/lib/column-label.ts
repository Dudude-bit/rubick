import type { AppColumnMeta } from "@/components/ui/table-features";
import type { HeaderSaying } from "@/i18n/column-header";
import type { T } from "@/i18n/useT";
import { textWidth } from "@/lib/text-width";

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

/** Where text is not laid out: 7px a glyph of 11px medium Inter, and a short word runs wider ("Memory", "Домены"). */
const GLYPH_PX = 7;
const SHORT_WORD_SLACK_PX = 5;
/** A sort control's 12px mark, its 4px gap and the button's own 8px of padding. */
const SORT_MARK_PX = 24;
/** The header cell's own padding. */
const PADDING_PX = 20;

/**
 * The narrowest a column can be drawn with its header whole, from the width
 * its words are drawn at in the reader's language.
 */
export function headerFloor(column: LabelledColumn, t: T): number {
  const label = columnLabel(column, t);
  if (!label) return 0;
  const sortable = (column.meta as AppColumnMeta | undefined)?.label;
  const drawn =
    textWidth(label, "header") ?? label.length * GLYPH_PX + SHORT_WORD_SLACK_PX;
  return Math.ceil(drawn + (sortable ? SORT_MARK_PX : 0) + PADDING_PX);
}

const pixels = (declared: AppColumnMeta["floor"], t: T) =>
  typeof declared === "function" ? declared(t) : (declared ?? 0);

/** The narrowest a column is drawn: what its cells declare, and its header's words. */
export function columnFloor(column: LabelledColumn, t: T): number {
  const meta = column.meta as AppColumnMeta | undefined;
  return Math.max(pixels(meta?.floor, t), headerFloor(column, t));
}

/** The width a column keeps while the table has room for every column's. */
export function columnIdeal(column: LabelledColumn, t: T): number {
  return pixels((column.meta as AppColumnMeta | undefined)?.ideal, t);
}
