import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { PathIdentity } from "@/generated/types";
import { commands } from "@/lib/commands";
import { logError } from "@/lib/logger";

interface PrivacyState {
  hidePaths: boolean;
  setHidePaths: (hide: boolean) => void;
  identity: PathIdentity | null;
}

/** Diagnostics' "Redact names and paths", which every screen printing a local path follows. */
export const usePrivacyStore = create<PrivacyState>()(
  persist(
    (set) => ({
      hidePaths: true,
      setHidePaths: (hidePaths) => set({ hidePaths }),
      identity: null,
    }),
    {
      name: "privacy",
      version: 1,
      partialize: ({ hidePaths }) => ({ hidePaths }),
    }
  )
);

/** Before the first render, so no path is drawn before it can be hidden. */
export const loadPathIdentity = () =>
  commands.pathIdentity().then(
    (identity) => usePrivacyStore.setState({ identity }),
    (error: unknown) =>
      logError("Could not read what to hide in paths", {
        context: "privacy",
        data: { error },
      })
  );
