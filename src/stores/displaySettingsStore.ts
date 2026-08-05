import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TableDensity = "compact" | "comfortable";
export type ResourceColouring = "full" | "minimal" | "off";

export interface DisplaySettingsState {
  tableDensity: TableDensity;
  setTableDensity: (density: TableDensity) => void;
  resourceColouring: ResourceColouring;
  setResourceColouring: (value: ResourceColouring) => void;
}

export const useDisplaySettingsStore = create<DisplaySettingsState>()(
  persist(
    (set) => ({
      // Ops tooling is read-first: fitting more rows on screen beats
      // breathing room. Comfortable stays one click away in the toolbar.
      tableDensity: "compact",
      setTableDensity: (density) => set({ tableDensity: density }),
      resourceColouring: "full",
      setResourceColouring: (value) => set({ resourceColouring: value }),
    }),
    {
      name: "display-settings",
      // `persist` writes the initial state on first launch, so every
      // existing install has `comfortable` on disk whether or not the user
      // ever picked it — a bare default change would reach nobody. Bumping
      // the version resets density once; the toolbar toggle puts it back
      // for anyone who did want the roomier rows.
      version: 2,
      migrate: (persisted, version) => {
        const state = persisted as Partial<DisplaySettingsState> | undefined;
        const withDensity =
          version === 0
            ? { ...state, tableDensity: "compact" as TableDensity }
            : state;
        // An install written before this field has no colouring on disk at
        // all, and the initialiser's default never reaches it — persist
        // rehydrates over it. Filling the gap here, not overwriting, is what
        // keeps an existing choice intact.
        return {
          ...withDensity,
          resourceColouring:
            withDensity?.resourceColouring ?? ("full" as ResourceColouring),
        } as DisplaySettingsState;
      },
    }
  )
);
