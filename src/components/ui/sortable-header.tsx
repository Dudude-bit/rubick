/**
 * A column header that sorts, with the arrow that says which way.
 *
 * Written once rather than per list, because a header renderer is a component
 * *type* to `flexRender`: an arrow function built inside a list's own header
 * would be a new type on every render, and the header under the pointer would
 * be replaced mid-click. Used inside a column literal that is itself built
 * once, which is the rule the rest of the columns already follow.
 *
 * Sorting is opt-in per column, and deliberately so. Most columns here have
 * no accessor — they render a derived cell from the whole row — so TanStack
 * has no value to compare and a header that offered to sort would do nothing
 * when pressed. A column becomes sortable by saying what to sort *by*.
 */

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";
import type { RowData } from "@/components/ui/table-features";

/** What TanStack hands a header renderer, narrowed to what this needs. */
interface SortableColumn {
  getIsSorted: () => false | "asc" | "desc";
  toggleSorting: (desc?: boolean) => void;
}

export function SortableHeader<TData extends RowData>({
  column,
  children,
}: {
  column: SortableColumn;
  /** The label — usually a `<T>`, so the words stay translated. */
  children: ReactNode;
  /** Unused; present so the generic is inferred from the column's table. */
  _row?: TData;
}) {
  const t = useT();
  const sorted = column.getIsSorted();
  const Mark =
    sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown;

  return (
    <button
      type="button"
      onClick={() => column.toggleSorting()}
      // The hit area is the whole cell, not the words: a 40px target is the
      // difference between sorting a column and selecting its label.
      className={cn(
        "-mx-1 inline-flex min-h-[28px] items-center gap-1 rounded px-1",
        "transition-colors hover:bg-hover focus-visible:bg-hover",
        "focus-visible:outline-none",
        sorted ? "text-fg" : "text-fg-mut"
      )}
      aria-label={t("action", "sortByColumn")}
    >
      {children}
      <Mark
        className={cn(
          "h-3 w-3 flex-none",
          sorted ? "opacity-100" : "opacity-40"
        )}
        aria-hidden="true"
      />
    </button>
  );
}
