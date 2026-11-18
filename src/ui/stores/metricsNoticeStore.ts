import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { MetricsAbsence } from "@/lib/metrics-absence";
import { entryOf, named, type Named, withEntry } from "@/lib/named";

interface MetricsNoticeState {
  /** Per context, the reasons whose banner the reader put away. */
  hidden: Named<MetricsAbsence[]>;
  hide: (context: string, absence: MetricsAbsence) => void;
}

export const useMetricsNoticeStore = create<MetricsNoticeState>()(
  persist(
    (set) => ({
      hidden: named(),
      hide: (context, absence) =>
        set((state) => ({
          hidden: withEntry(state.hidden, context, [
            ...new Set([...(entryOf(state.hidden, context) ?? []), absence]),
          ]),
        })),
    }),
    { name: "metrics-notices", version: 1 }
  )
);
