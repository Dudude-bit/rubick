import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistedByName } from "@/lib/kept-by-name";
import type { MetricsAbsence } from "@/lib/metrics-absence";
import {
  entryOf,
  named,
  type Named,
  withEntry,
  withoutEntry,
} from "@/lib/named";

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

// A banner put away for the last cluster under the name says nothing of this one.
persistedByName((context) =>
  useMetricsNoticeStore.setState((state) => ({
    hidden: withoutEntry(state.hidden, context),
  }))
);
