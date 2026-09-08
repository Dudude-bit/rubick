import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { JournalEntry, ObservedSpan } from "@/lib/changes";

/** Entries kept per cluster; the oldest go first. */
export const MAX_JOURNAL_ENTRIES = 5000;
/** Nothing older than this is kept, whatever the count. */
export const JOURNAL_TTL_MS = 7 * 24 * 60 * 60_000;

interface ChangeJournalState {
  entries: JournalEntry[];
  spans: Record<string, ObservedSpan[]>;
  record: (entries: JournalEntry[]) => void;
  /** The watch is up and has its baseline. */
  beginSpan: (context: string, now: number) => void;
  /** Still alive; a crash after this leaves the span ending here. */
  heartbeat: (context: string, now: number) => void;
  endSpan: (context: string, now: number) => void;
  forget: (context: string) => void;
}

function trimmed(entries: JournalEntry[], now: number): JournalEntry[] {
  const fresh = entries.filter((entry) => now - entry.at < JOURNAL_TTL_MS);
  const byContext = new Map<string, number>();
  const kept: JournalEntry[] = [];
  for (const entry of [...fresh].reverse()) {
    const seen = byContext.get(entry.context) ?? 0;
    if (seen >= MAX_JOURNAL_ENTRIES) continue;
    byContext.set(entry.context, seen + 1);
    kept.push(entry);
  }
  return kept.reverse();
}

/** A span left open by a crash ends where it was last seen alive. */
function closed(spans: Record<string, ObservedSpan[]>) {
  const out: Record<string, ObservedSpan[]> = {};
  for (const [context, list] of Object.entries(spans)) {
    out[context] = list.map((span) =>
      span.to === null ? { ...span, to: span.seenAt } : span
    );
  }
  return out;
}

export const useChangeJournalStore = create<ChangeJournalState>()(
  persist(
    (set, get) => ({
      entries: [],
      spans: {},
      record: (entries) => {
        if (entries.length === 0) return;
        const now = entries[entries.length - 1].at;
        set((state) => ({
          entries: trimmed([...state.entries, ...entries], now),
        }));
      },
      beginSpan: (context, now) =>
        set((state) => ({
          spans: {
            ...state.spans,
            [context]: [
              ...(state.spans[context] ?? []).map((span) =>
                span.to === null ? { ...span, to: span.seenAt } : span
              ),
              { from: now, seenAt: now, to: null },
            ],
          },
        })),
      heartbeat: (context, now) => {
        const list = get().spans[context] ?? [];
        const open = list.findIndex((span) => span.to === null);
        if (open === -1) return;
        set((state) => ({
          spans: {
            ...state.spans,
            [context]: (state.spans[context] ?? []).map((span, index) =>
              index === open ? { ...span, seenAt: now } : span
            ),
          },
        }));
      },
      endSpan: (context, now) =>
        set((state) => ({
          spans: {
            ...state.spans,
            [context]: (state.spans[context] ?? []).map((span) =>
              span.to === null ? { ...span, seenAt: now, to: now } : span
            ),
          },
        })),
      forget: (context) =>
        set((state) => ({
          entries: state.entries.filter((entry) => entry.context !== context),
          spans: Object.fromEntries(
            Object.entries(state.spans).filter(([key]) => key !== context)
          ),
        })),
    }),
    {
      name: "change-journal",
      version: 1,
      partialize: (state) => ({ entries: state.entries, spans: state.spans }),
      // Whatever was open when the app closed did not keep watching after
      // it: the stretch since is a gap, not a quiet cluster.
      migrate: (persisted) => {
        const stored = (persisted ?? {}) as Partial<ChangeJournalState>;
        return {
          entries: Array.isArray(stored.entries) ? stored.entries : [],
          spans: closed(stored.spans ?? {}),
        } as ChangeJournalState;
      },
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<ChangeJournalState>;
        return {
          ...current,
          entries: Array.isArray(stored.entries) ? stored.entries : [],
          spans: closed(stored.spans ?? {}),
        };
      },
    }
  )
);
