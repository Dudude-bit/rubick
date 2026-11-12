/**
 * Theme Store
 *
 * Manages the application's color theme with persistence via backend.
 * Supports light, dark, and system-preference themes.
 *
 * @module stores/themeStore
 */

import { create } from "zustand";
import { translate } from "@/i18n";
import { commands } from "@/lib/commands";
import { applyTheme, cachedTheme, type Theme } from "@/lib/theme";
import { toastError } from "@/lib/toast-error";
import { currentLocale } from "./localeStore";

export type { Theme };

/** Theme store state and actions */
interface ThemeState {
  /** Current theme setting */
  theme: Theme;
  /** Loading state */
  loading: boolean;
  /** Set the active theme; the promise settles once it is saved, or said not to be. */
  setTheme: (theme: Theme) => Promise<void>;
  /** Load theme from backend */
  loadTheme: () => Promise<void>;
}

/** The theme chosen and not yet handed to a save, and the save in flight. */
let unsaved: Theme | null = null;
let saving: Promise<void> | null = null;
let chosen = false;

/** One save at a time and the last choice last, so two quick switches cannot land on disk in the other order. */
async function saveChosen(): Promise<void> {
  while (unsaved !== null) {
    const theme = unsaved;
    unsaved = null;
    try {
      await commands.saveThemeConfig({
        theme,
        accentColor: "#3b82f6",
        fontSize: 14,
        compact: false,
      });
    } catch (error) {
      toastError(
        translate(currentLocale(), "settings", "themeNotSaved"),
        error
      );
    }
  }
}

/**
 * Zustand store for theme management
 *
 * @example
 * ```tsx
 * const { theme, setTheme } = useThemeStore();
 * setTheme("dark");
 * ```
 */
export const useThemeStore = create<ThemeState>((set) => ({
  theme: cachedTheme(),
  loading: false,

  setTheme: (theme) => {
    chosen = true;
    set({ theme });
    unsaved = theme;
    saving ??= saveChosen().finally(() => {
      saving = null;
    });
    return saving;
  },

  loadTheme: async () => {
    set({ loading: true });
    try {
      const config = await commands.getThemeConfig();
      // A theme picked while this was read is newer than what it read.
      if (!chosen) set({ theme: (config.theme || "dark") as Theme });
    } catch (error) {
      console.error("Failed to load theme:", error);
    } finally {
      set({ loading: false });
    }
  },
}));

/** Paints each theme the store takes in the click that chose it: through React the switch waited for the whole app to render again. */
export function followTheme(): () => void {
  applyTheme(useThemeStore.getState().theme);
  return useThemeStore.subscribe((state, before) => {
    if (state.theme !== before.theme) applyTheme(state.theme);
  });
}

// Initialize theme on store creation
if (typeof window !== "undefined") {
  const store = useThemeStore.getState();
  store.loadTheme().catch(console.error);
}
