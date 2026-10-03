/**
 * Theme Store
 *
 * Manages the application's color theme with persistence via backend.
 * Supports light, dark, and system-preference themes.
 *
 * @module stores/themeStore
 */

import { create } from "zustand";
import { commands } from "@/lib/commands";

/** Available theme options */
export type Theme = "light" | "dark" | "system";

/** Theme store state and actions */
interface ThemeState {
  /** Current theme setting */
  theme: Theme;
  /** Loading state */
  loading: boolean;
  /** Set the active theme */
  setTheme: (theme: Theme) => Promise<void>;
  /** Load theme from backend */
  loadTheme: () => Promise<void>;
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
  theme: "dark",
  loading: false,

  setTheme: async (theme) => {
    set({ theme });
    try {
      await commands.saveThemeConfig({
        theme,
        accentColor: "#3b82f6",
        fontSize: 14,
        compact: false,
      });
    } catch (error) {
      console.error("Failed to save theme:", error);
    }
  },

  loadTheme: async () => {
    set({ loading: true });
    try {
      const config = await commands.getThemeConfig();
      const theme = (config.theme || "dark") as Theme;
      set({ theme });
    } catch (error) {
      console.error("Failed to load theme:", error);
    } finally {
      set({ loading: false });
    }
  },
}));

// Initialize theme on store creation
if (typeof window !== "undefined") {
  const store = useThemeStore.getState();
  store.loadTheme().catch(console.error);
}
