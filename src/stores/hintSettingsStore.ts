import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { SearchEngine } from "@/lib/hints";

interface HintSettingsState {
  engine: SearchEngine;
  /** A URL with `{q}` in it, for the custom engine. */
  customUrl: string;
  /** Pod, namespace, image and host names replaced before the query leaves the app. */
  stripNames: boolean;
  /** Whether the hand-off carries the last log lines. */
  includeLogLines: boolean;
  showPanel: boolean;
  setEngine: (engine: SearchEngine) => void;
  setCustomUrl: (url: string) => void;
  setStripNames: (on: boolean) => void;
  setIncludeLogLines: (on: boolean) => void;
  setShowPanel: (on: boolean) => void;
}

export const useHintSettingsStore = create<HintSettingsState>()(
  persist(
    (set) => ({
      engine: "google",
      customUrl: "",
      stripNames: true,
      includeLogLines: true,
      showPanel: true,
      setEngine: (engine) => set({ engine }),
      setCustomUrl: (customUrl) => set({ customUrl }),
      setStripNames: (stripNames) => set({ stripNames }),
      setIncludeLogLines: (includeLogLines) => set({ includeLogLines }),
      setShowPanel: (showPanel) => set({ showPanel }),
    }),
    {
      name: "hints",
      version: 1,
      partialize: (state) => ({
        engine: state.engine,
        customUrl: state.customUrl,
        stripNames: state.stripNames,
        includeLogLines: state.includeLogLines,
        showPanel: state.showPanel,
      }),
    }
  )
);
