/**
 * Whether Settings is open, and on which section.
 *
 * Settings used to be a route, which made it a page of whichever tab was
 * active: opening it replaced the list the reader was on, retitled the tab
 * "Settings", and put every gate in front of the outlet, a refused session
 * or a tab mid-switch, in front of Settings too. The one screen for fixing a
 * kubeconfig path was unreachable exactly when the kubeconfig was the
 * problem. Out of the router it is a layer over the window, and the page
 * underneath stays where it was.
 *
 * @module stores/settingsStore
 */

import { create } from "zustand";

import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
} from "@/components/settings/settings-sections";

/** Logical, never a glyph: `Kbd` and `formatShortcut` render it per platform. */
export const SETTINGS_SHORTCUT = "mod+,";

interface SettingsState {
  open: boolean;
  section: string;
  /**
   * Open on a section, or on the one last open. A name nothing is called
   * opens the default rather than an empty pane.
   */
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  toggleSettings: () => void;
}

const knownSection = (id: string | undefined) =>
  SETTINGS_SECTIONS.find((section) => section.id === id)?.id;

export const useSettingsStore = create<SettingsState>((set) => ({
  open: false,
  section: DEFAULT_SETTINGS_SECTION,
  openSettings: (section) =>
    set((state) => ({
      open: true,
      section:
        section === undefined
          ? state.section
          : (knownSection(section) ?? DEFAULT_SETTINGS_SECTION),
    })),
  closeSettings: () => set({ open: false }),
  toggleSettings: () => set((state) => ({ open: !state.open })),
}));
