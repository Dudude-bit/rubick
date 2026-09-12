import { create } from "zustand";

import type { PeekTarget } from "@/hooks/usePeek";

/** What the reader right-clicked, and where the pointer was. */
export interface ObjectMenuTarget extends PeekTarget {
  to: string;
  x: number;
  y: number;
}

interface ObjectMenuState {
  target: ObjectMenuTarget | null;
  open: (target: ObjectMenuTarget) => void;
  close: () => void;
}

/**
 * One menu for every object link in the window, rather than a menu root
 * per row: a list of ten thousand pods must not mount ten thousand of them.
 */
export const useObjectMenuStore = create<ObjectMenuState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
