import { create } from "zustand";

interface ShortcutsState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useShortcutsStore = create<ShortcutsState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
