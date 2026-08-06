import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TableDensity = "compact" | "comfortable";
export type ResourceColouring = "full" | "minimal" | "off";

/**
 * Bounds for the peek panel's width.
 *
 * The floor is the narrowest a two-column key/value row stays readable at;
 * the ceiling stops the panel from becoming the app on a wide monitor. The
 * default is wide enough that the Logs and YAML tabs are usable on first
 * open without a drag, and narrow enough to keep the list behind readable.
 */
export const PEEK_WIDTH_MIN = 360;
export const PEEK_WIDTH_MAX = 1200;
export const PEEK_WIDTH_DEFAULT = 480;

export interface DisplaySettingsState {
  tableDensity: TableDensity;
  setTableDensity: (density: TableDensity) => void;
  resourceColouring: ResourceColouring;
  setResourceColouring: (value: ResourceColouring) => void;
  peekWidth: number;
  setPeekWidth: (width: number) => void;
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
      peekWidth: PEEK_WIDTH_DEFAULT,
      setPeekWidth: (width) =>
        set({
          peekWidth: Math.min(
            Math.max(Math.round(width), PEEK_WIDTH_MIN),
            PEEK_WIDTH_MAX
          ),
        }),
    }),
    {
      name: "display-settings",
      // `persist` writes the initial state on first launch, so every
      // existing install has `comfortable` on disk whether or not the user
      // ever picked it — a bare default change would reach nobody. Bumping
      // the version resets density once; the toolbar toggle puts it back
      // for anyone who did want the roomier rows.
      version: 3,
      migrate: (persisted, version) => {
        const state = persisted as Partial<DisplaySettingsState> | undefined;
        const withDensity =
          version === 0
            ? { ...state, tableDensity: "compact" as TableDensity }
            : state;
        // An install written before this field has no colouring on disk at
        // all, and the initialiser's default never reaches it — persist
        // rehydrates over it. Filling the gap here, not overwriting, is what
        // keeps an existing choice intact. Same for the peek width, added in
        // version 3: fill the gap, never overwrite a width someone dragged.
        const storedWidth = withDensity?.peekWidth;
        return {
          ...withDensity,
          resourceColouring:
            withDensity?.resourceColouring ?? ("full" as ResourceColouring),
          peekWidth:
            typeof storedWidth === "number" && Number.isFinite(storedWidth)
              ? Math.min(Math.max(storedWidth, PEEK_WIDTH_MIN), PEEK_WIDTH_MAX)
              : PEEK_WIDTH_DEFAULT,
        } as DisplaySettingsState;
      },
    }
  )
);
