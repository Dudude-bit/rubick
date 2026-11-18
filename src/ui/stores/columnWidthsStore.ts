import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ColumnSizingState } from "@tanstack/react-table";

import {
  entryOf,
  named,
  withEntry,
  withoutEntry,
  type Named,
} from "@/lib/named";

/** One table's columns, by column id, in pixels: the table's own shape. */
export type ColumnWidths = ColumnSizingState;

interface ColumnWidthsState {
  /** Keyed by what the table lists, so the Pods list keeps its own. */
  widths: Named<ColumnWidths>;
  set: (key: string, widths: ColumnWidths) => void;
  reset: (key: string) => void;
}

/**
 * The widths a reader dragged, kept across navigation.
 *
 * A width that forgot itself on the way to the next page would be a control
 * that does not hold, so this is persisted rather than component state. Keyed
 * by the table's row label — the kind it lists — because that is what the
 * columns belong to: a Pods table embedded on a Deployment page and the Pods
 * page itself show the same columns and should agree about them.
 *
 * Nothing here is a fact about a cluster, so it is not per context.
 */
export const useColumnWidthsStore = create<ColumnWidthsState>()(
  persist(
    (set) => ({
      widths: named(),
      set: (key, widths) =>
        set((state) => ({ widths: withEntry(state.widths, key, widths) })),
      reset: (key) =>
        set((state) =>
          entryOf(state.widths, key) === undefined
            ? state
            : { widths: withoutEntry(state.widths, key) }
        ),
    }),
    { name: "column-widths" }
  )
);
