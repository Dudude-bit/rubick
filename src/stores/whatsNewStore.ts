import { create } from "zustand";
import { persist } from "zustand/middleware";

interface WhatsNewState {
  /** The version whose notes were last shown, or never shown on purpose. */
  seenVersion: string | null;
  /** The versions the open dialog is about; empty when it is closed. */
  showing: string[];
  markSeen: (version: string) => void;
  show: (versions: string[]) => void;
  close: () => void;
}

export const useWhatsNewStore = create<WhatsNewState>()(
  persist(
    (set) => ({
      seenVersion: null,
      showing: [],
      markSeen: (version) => set({ seenVersion: version }),
      show: (versions) => set({ showing: versions }),
      close: () => set({ showing: [] }),
    }),
    {
      name: "whats-new",
      partialize: (state) => ({ seenVersion: state.seenVersion }),
    }
  )
);
