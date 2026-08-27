/**
 * Updater Store
 *
 * Manages application update state and settings with persistence via backend.
 * Handles automatic update checks and manual update operations.
 *
 * @module stores/updaterStore
 */

import { translate } from "@/i18n";
import { currentLocale } from "./localeStore";
import { create } from "zustand";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { commands } from "@/lib/commands";

/** Updater store state and actions */
interface UpdaterState {
  // Update status
  available: boolean;
  version?: string;
  notes?: string;
  checking: boolean;
  downloading: boolean;
  progress: number;
  error?: string;

  // Settings
  autoCheckEnabled: boolean;
  settingsLoaded: boolean;

  // Internal state
  update: Update | null;

  // Actions
  loadSettings: () => Promise<void>;
  setAutoCheckEnabled: (enabled: boolean) => Promise<void>;
  checkForUpdates: () => Promise<Update | null>;
  downloadAndInstall: () => Promise<void>;
  dismissUpdate: () => void;
}

/**
 * Zustand store for update management
 *
 * @example
 * ```tsx
 * const { available, version, checkForUpdates } = useUpdaterStore();
 * if (available) {
 *   console.log(`Update ${version} available!`);
 * }
 * ```
 */
export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  // Initial state
  available: false,
  version: undefined,
  notes: undefined,
  checking: false,
  downloading: false,
  progress: 0,
  error: undefined,
  autoCheckEnabled: true,
  settingsLoaded: false,
  update: null,

  loadSettings: async () => {
    try {
      const settings = await commands.getUpdaterSettings();
      set({
        autoCheckEnabled: settings.autoCheckEnabled,
        settingsLoaded: true,
      });
    } catch (error) {
      console.error("Failed to load updater settings:", error);
      set({ settingsLoaded: true });
    }
  },

  setAutoCheckEnabled: async (enabled: boolean) => {
    set({ autoCheckEnabled: enabled });
    try {
      await commands.saveUpdaterSettings({ autoCheckEnabled: enabled });
    } catch (error) {
      console.error("Failed to save updater settings:", error);
    }
  },

  checkForUpdates: async () => {
    set({ checking: true, error: undefined });
    try {
      const updateResult = await check();
      if (updateResult) {
        set({
          update: updateResult,
          checking: false,
          available: true,
          version: updateResult.version,
          notes: updateResult.body ?? undefined,
        });
        return updateResult;
      } else {
        set({ checking: false, available: false });
        return null;
      }
    } catch (error) {
      set({
        checking: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  },

  downloadAndInstall: async () => {
    const state = get();
    let currentUpdate = state.update;

    if (!currentUpdate) {
      currentUpdate = await check();
      if (!currentUpdate) return;
      set({ update: currentUpdate });
    }

    set({ downloading: true, progress: 0 });

    let downloaded = 0;
    let contentLength = 0;

    try {
      await currentUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? 0;
            break;
          case "Progress": {
            downloaded += event.data.chunkLength;
            const progress =
              contentLength > 0
                ? Math.round((downloaded / contentLength) * 100)
                : 0;
            set({ progress });
            break;
          }
          case "Finished":
            set({ downloading: false, progress: 100 });
            break;
        }
      });

      await relaunch();
    } catch (error) {
      set({
        downloading: false,
        error:
          error instanceof Error
            ? error.message
            : translate(currentLocale(), "settings", "installationFailed"),
      });
    }
  },

  dismissUpdate: () => {
    set({
      available: false,
      version: undefined,
      notes: undefined,
      update: null,
    });
  },
}));
