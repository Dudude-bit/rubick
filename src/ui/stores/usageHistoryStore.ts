/**
 * Usage History Store
 *
 * The ring buffers behind the usage charts. Deliberately **not** persisted:
 * the label on the chart says "watched since you opened this page", and a
 * buffer that came back after a restart would make that sentence false —
 * there is no way to know the app was closed for a minute or for a week,
 * and a line drawn straight across that hole is a lie about a gap.
 *
 * What it does survive is navigation. Moving to Logs and back, or to
 * another pod and back inside the same session, keeps the window: the
 * store is module state, not component state, so nothing unmounts it.
 *
 * Keyed by `kind/uid`. Never by name — a Deployment rolls and the new pod
 * arrives holding the old name for a moment, and a buffer keyed on the
 * name would splice one container's heap onto another's.
 *
 * @module stores/usageHistoryStore
 */
import { create } from "zustand";
import {
  appendSample,
  MAX_SAMPLES,
  type UsageSample,
} from "@/lib/usage-history";
import {
  entriesOf,
  entryOf,
  named,
  type Named,
  withEntry,
  withoutEntry,
} from "@/lib/named";

/**
 * How many objects keep a buffer at once.
 *
 * A reader walking a namespace opens pods one after another and nothing
 * ever navigates "away" in a way the store could hear, so the map only
 * grows. At the cap the least recently written series is dropped — the pod
 * looked at longest ago, which is the one whose chart nobody is waiting
 * on. Forty pods therefore costs forty short buffers, not forty full ones:
 * the ceiling is 32 x 900 samples (~1MB) whatever the reader does.
 */
export const MAX_SERIES = 32;

export interface UsageSeries {
  samples: readonly UsageSample[];
  /** Epoch ms of the last write, for the eviction order. */
  touchedAt: number;
}

interface UsageHistoryState {
  series: Named<UsageSeries>;
  /** Appends one poll to a series, creating and evicting as needed. */
  record: (key: string, sample: UsageSample) => void;
  /** Drops a series outright — used when an object is known to be gone. */
  forget: (key: string) => void;
  clear: () => void;
}

/** `Pod/9f3c…` — the identity a buffer belongs to. */
export function seriesKey(
  kind: string,
  uid: string | null | undefined
): string | null {
  if (!uid) return null;
  return `${kind}/${uid}`;
}

export const useUsageHistoryStore = create<UsageHistoryState>((set) => ({
  series: named(),

  record: (key, sample) =>
    set((state) => {
      const existing = entryOf(state.series, key);
      const samples = appendSample(
        existing?.samples ?? [],
        sample,
        MAX_SAMPLES
      );
      // The same poll reaching two subscribers must not re-render either.
      if (existing && samples === existing.samples) return state;

      const series = entriesOf(
        withEntry(state.series, key, { samples, touchedAt: sample.t })
      );
      if (series.length <= MAX_SERIES) return { series: named(series) };
      const oldest = series.reduce((first, each) =>
        each[1].touchedAt < first[1].touchedAt ? each : first
      );
      return { series: named(series.filter((each) => each !== oldest)) };
    }),

  forget: (key) =>
    set((state) => {
      if (entryOf(state.series, key) === undefined) return state;
      return { series: withoutEntry(state.series, key) };
    }),

  clear: () => set({ series: named() }),
}));
