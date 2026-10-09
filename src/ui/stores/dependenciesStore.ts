/**
 * Dependencies Store
 *
 * Manages external CLI dependencies availability status (helm, kubectl, etc.)
 * Checks on app startup and caches results.
 *
 * @module stores/dependenciesStore
 */

import { create } from "zustand";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type { CliAvailability } from "@/generated/types";

/** Dependencies store state */
interface DependenciesState {
  helm: CliAvailability | null;
  kubectl: CliAvailability | null;
  isChecking: boolean;
  lastChecked: Date | null;

  // Actions
  checkHelmAvailability: () => Promise<void>;
  checkKubectlAvailability: () => Promise<void>;
  checkAllDependencies: () => Promise<void>;
}

export const useDependenciesStore = create<DependenciesState>((set, get) => ({
  helm: null,
  kubectl: null,
  isChecking: false,
  lastChecked: null,

  checkHelmAvailability: async () => {
    set({ isChecking: true });
    try {
      const result = await commands.checkHelmAvailability();
      set({
        helm: result,
        isChecking: false,
        lastChecked: new Date(),
      });
    } catch (error) {
      set({
        helm: {
          available: false,
          version: null,
          error: errorToShow(error),
          path: null,
          searchedPaths: [],
        },
        isChecking: false,
        lastChecked: new Date(),
      });
    }
  },

  checkKubectlAvailability: async () => {
    set({ isChecking: true });
    try {
      const result = await commands.checkKubectlAvailability();
      set({
        kubectl: result,
        isChecking: false,
        lastChecked: new Date(),
      });
    } catch (error) {
      set({
        kubectl: {
          available: false,
          version: null,
          error: errorToShow(error),
          path: null,
          searchedPaths: [],
        },
        isChecking: false,
        lastChecked: new Date(),
      });
    }
  },

  checkAllDependencies: async () => {
    const { checkHelmAvailability, checkKubectlAvailability } = get();
    await Promise.all([checkHelmAvailability(), checkKubectlAvailability()]);
  },
}));
