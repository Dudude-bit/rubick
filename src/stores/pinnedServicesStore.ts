import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  MAX_PINNED_PER_CONTEXT,
  pinKey,
  type ServicePin,
} from "@/lib/my-services";

export type PinOutcome = "pinned" | "already" | "full";

interface PinnedServicesState {
  pins: ServicePin[];
  /** Refuses past the cap rather than dropping somebody's oldest choice. */
  pin: (pin: ServicePin) => PinOutcome;
  unpin: (context: string, key: string) => void;
  /** Everything pinned in this cluster, in the order it was pinned. */
  forContext: (context: string) => ServicePin[];
  isPinned: (context: string, key: string) => boolean;
}

export const usePinnedServicesStore = create<PinnedServicesState>()(
  persist(
    (set, get) => ({
      pins: [],
      pin: (pin) => {
        const here = get().pins.filter(
          (entry) => entry.context === pin.context
        );
        if (here.some((entry) => pinKey(entry) === pinKey(pin)))
          return "already";
        if (here.length >= MAX_PINNED_PER_CONTEXT) return "full";
        set((state) => ({ pins: [...state.pins, pin] }));
        return "pinned";
      },
      unpin: (context, key) =>
        set((state) => ({
          pins: state.pins.filter(
            (entry) => entry.context !== context || pinKey(entry) !== key
          ),
        })),
      forContext: (context) =>
        get()
          .pins.filter((entry) => entry.context === context)
          .sort((a, b) => a.pinnedAt - b.pinnedAt),
      isPinned: (context, key) =>
        get().pins.some(
          (entry) => entry.context === context && pinKey(entry) === key
        ),
    }),
    { name: "pinned-services" }
  )
);
