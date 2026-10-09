import { create } from "zustand";

import type { DeepLink } from "@/lib/deep-link";

/**
 * The link the window was opened from, until the reader dismisses it or
 * moves on. Two outcomes only: the link's cluster is in this kubeconfig and
 * the page is now showing live, or it is not and nothing was opened. Which
 * of a similarly named pair of clusters a link meant is never guessed.
 */
export type Arrival =
  | { status: "live"; link: DeepLink }
  | { status: "contextMissing"; link: DeepLink; known: string[] };

interface DeepLinkState {
  arrival: Arrival | null;
  arrive: (arrival: Arrival) => void;
  dismiss: () => void;
}

export const useDeepLinkStore = create<DeepLinkState>((set) => ({
  arrival: null,
  arrive: (arrival) => set({ arrival }),
  dismiss: () => set({ arrival: null }),
}));
