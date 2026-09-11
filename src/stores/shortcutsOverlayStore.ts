import { create } from "zustand";

interface ShortcutsOverlayState {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

export const useShortcutsOverlayStore = create<ShortcutsOverlayState>(
  (set) => ({
    open: false,
    toggle: () => set((state) => ({ open: !state.open })),
    close: () => set({ open: false }),
  })
);
