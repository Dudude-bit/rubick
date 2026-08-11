import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TableDensity = "compact" | "comfortable";
export type ResourceColouring = "full" | "minimal" | "off";

/**
 * How much of the log's density strip is drawn.
 *
 * "full" is the map: volume as height, the axis, the counts. "band" keeps
 * the navigation and throws away the chart — a few pixels that still say
 * where the errors are, still jump on click and still mark the viewport.
 * "off" is for the reader who wants neither, and costs them the map.
 *
 * One preference for every surface the viewer is mounted on, the peek panel
 * included: "do I want a chart above my log" is a fact about the reader, not
 * about the pane, and splitting it per surface would mean setting it twice
 * to be rid of it once.
 */
export type DensityStripMode = "full" | "band" | "off";

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
  densityStrip: DensityStripMode;
  setDensityStrip: (mode: DensityStripMode) => void;
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
      densityStrip: "full",
      setDensityStrip: (mode) => set({ densityStrip: mode }),
    }),
    {
      name: "display-settings",
      // `persist` writes the initial state on first launch, so every
      // existing install has `comfortable` on disk whether or not the user
      // ever picked it — a bare default change would reach nobody. Bumping
      // the version resets density once; the toolbar toggle puts it back
      // for anyone who did want the roomier rows.
      version: 4,
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
          // Added in version 4, and filled the same way: an install written
          // before it has no strip mode on disk, and persist rehydrates the
          // stored payload over the initialiser's default.
          densityStrip:
            withDensity?.densityStrip ?? ("full" as DensityStripMode),
          peekWidth:
            typeof storedWidth === "number" && Number.isFinite(storedWidth)
              ? Math.min(Math.max(storedWidth, PEEK_WIDTH_MIN), PEEK_WIDTH_MAX)
              : PEEK_WIDTH_DEFAULT,
        } as DisplaySettingsState;
      },
    }
  )
);
