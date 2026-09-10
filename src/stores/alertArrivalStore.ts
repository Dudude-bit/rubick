import { create } from "zustand";

import type { AlertReading } from "@/lib/alerts";

/**
 * The alert a page was opened from, until it is dismissed or the reader
 * moves on.
 *
 * Kept so the object's own page can show what the alert claimed beside what
 * the app read itself. It is not merged into anything: an alert is a claim
 * somebody's rule made at a moment that has passed, and the moment its words
 * are drawn as the object's state a person is sent hunting something that
 * ended before they woke up.
 */
interface AlertArrivalState {
  reading: AlertReading | null;
  /** The object the reader chose to open, which is not always the subject. */
  at: { kind: string; name: string; namespace: string | null } | null;
  arrive: (
    reading: AlertReading,
    at: { kind: string; name: string; namespace: string | null }
  ) => void;
  dismiss: () => void;
}

export const useAlertArrivalStore = create<AlertArrivalState>((set) => ({
  reading: null,
  at: null,
  arrive: (reading, at) => set({ reading, at }),
  dismiss: () => set({ reading: null, at: null }),
}));
