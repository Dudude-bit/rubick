import { create } from "zustand";
import { persist } from "zustand/middleware";

/** One table's columns, by column id, in pixels. */
export type ColumnWidths = Record<string, number>;

interface ColumnWidthsState {
  /** Keyed by what the table lists, so the Pods list keeps its own. */
  widths: Record<string, ColumnWidths>;
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
      widths: {},
      set: (key, widths) =>
        set((state) => ({ widths: { ...state.widths, [key]: widths } })),
      reset: (key) =>
        set((state) => {
          if (!(key in state.widths)) return state;
          const next = { ...state.widths };
          delete next[key];
          return { widths: next };
        }),
    }),
    { name: "column-widths" }
  )
);
