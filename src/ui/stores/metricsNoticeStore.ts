import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { MetricsAbsence } from "@/lib/metrics-absence";

interface MetricsNoticeState {
  /** Per context, the reasons whose banner the reader put away. */
  hidden: Record<string, MetricsAbsence[]>;
  hide: (context: string, absence: MetricsAbsence) => void;
}

export const useMetricsNoticeStore = create<MetricsNoticeState>()(
  persist(
    (set) => ({
      hidden: {},
      hide: (context, absence) =>
        set((state) => ({
          hidden: {
            ...state.hidden,
            [context]: [
              ...new Set([...(state.hidden[context] ?? []), absence]),
            ],
          },
        })),
    }),
    { name: "metrics-notices", version: 1 }
  )
);
