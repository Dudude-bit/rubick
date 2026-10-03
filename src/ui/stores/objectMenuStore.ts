import { create } from "zustand";

/**
 * What the reader right-clicked, and where the pointer was. Its own shape
 * rather than a `PeekTarget` with two fields added: the menu copies a name
 * and opens an address, and a kind and a namespace it never reads would be
 * three more things every caller has to be able to supply — which is what
 * kept the menu off the links that have no kind to give.
 */
export interface ObjectMenuTarget {
  name: string;
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
