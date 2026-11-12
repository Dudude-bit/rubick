import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistedByName } from "@/lib/kept-by-name";
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
    }),
    { name: "pinned-services" }
  )
);

// A pin is a Service by namespace and name: under another cluster it is that
// cluster's namesake, or a row saying the pinned Service is gone.
persistedByName((context) =>
  usePinnedServicesStore.setState((state) => ({
    pins: state.pins.filter((pin) => pin.context !== context),
  }))
);
