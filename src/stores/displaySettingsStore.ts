import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TableDensity = "compact" | "comfortable";

interface DisplaySettingsState {
  tableDensity: TableDensity;
  setTableDensity: (density: TableDensity) => void;
}

export const useDisplaySettingsStore = create<DisplaySettingsState>()(
  persist(
    (set) => ({
      // Ops tooling is read-first: fitting more rows on screen beats
      // breathing room. Comfortable stays one click away in the toolbar.
      tableDensity: "compact",
      setTableDensity: (density) => set({ tableDensity: density }),
    }),
    {
      name: "display-settings",
      // `persist` writes the initial state on first launch, so every
      // existing install has `comfortable` on disk whether or not the user
      // ever picked it — a bare default change would reach nobody. Bumping
      // the version resets density once; the toolbar toggle puts it back
      // for anyone who did want the roomier rows.
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as Partial<DisplaySettingsState> | undefined;
        if (version === 0) {
          return { ...state, tableDensity: "compact" as TableDensity };
        }
        return state as DisplaySettingsState;
      },
    }
  )
);
