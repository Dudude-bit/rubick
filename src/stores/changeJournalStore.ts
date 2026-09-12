import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { JournalEntry, ObservedSpan } from "@/lib/changes";

/** Entries kept per cluster; the oldest go first. */
export const MAX_JOURNAL_ENTRIES = 5000;
/** Nothing older than this is kept, whatever the count. */
export const JOURNAL_TTL_MS = 7 * 24 * 60 * 60_000;
/** How often an open span is stamped alive. */
export const HEARTBEAT_MS = 30_000;
/**
 * A heartbeat this late did not run: the machine was asleep or the tab was
 * frozen, and nothing was being watched in between. Extending the span to
 * `now` would draw those hours as a quiet cluster.
 */
export const HEARTBEAT_MISSED_MS = 3 * HEARTBEAT_MS;
/** Writes are batched: the whole journal is re-serialised on every set. */
const WRITE_AFTER_MS = 2_000;

/**
 * `localStorage` behind a timer. A busy cluster records on every watch batch
 * and every heartbeat, and each `set` re-serialises up to
 * `MAX_JOURNAL_ENTRIES` rows on the main thread.
 */
function batchedStorage(): Storage {
  let pending: Record<string, string> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const writes = pending;
    pending = {};
    for (const [key, value] of Object.entries(writes)) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // A full or refused store loses the journal, never the session.
      }
    }
  };
  if (typeof window !== "undefined") window.addEventListener("pagehide", flush);
  return {
    ...window.localStorage,
    getItem: (key) => pending[key] ?? window.localStorage.getItem(key),
    setItem: (key, value) => {
      pending[key] = value;
      timer ??= setTimeout(flush, WRITE_AFTER_MS);
    },
    removeItem: (key) => {
      delete pending[key];
      window.localStorage.removeItem(key);
    },
  } as Storage;
}

/** Overlapping and touching spans folded together, and the old ones dropped. */
function pruned(spans: ObservedSpan[], now: number): ObservedSpan[] {
  const live = spans
    .filter((span) => now - (span.to ?? span.seenAt) < JOURNAL_TTL_MS)
    .sort((a, b) => a.from - b.from);
  const out: ObservedSpan[] = [];
  for (const span of live) {
    const last = out[out.length - 1];
    if (last && last.to !== null && span.from <= last.to) {
      out[out.length - 1] = {
        from: last.from,
        seenAt: Math.max(last.seenAt, span.seenAt),
        to: span.to === null ? null : Math.max(last.to, span.to),
      };
      continue;
    }
    out.push(span);
  }
  return out;
}

interface ChangeJournalState {
  entries: JournalEntry[];
  spans: Record<string, ObservedSpan[]>;
  /**
   * What cluster each context name was last seen to be, by the `kube-system`
   * UID. A context name is a label somebody chose, not a cluster: torn down
   * and rebuilt under the same name, a `kind` cluster would inherit the hours
   * the old one was watched.
   */
  identities: Record<string, string>;
  /**
   * Told which cluster a context turned out to be. A different one drops what
   * was recorded under that name; an unknown one — a reader who may not read
   * `kube-system` — drops nothing, because "could not tell" is not "another
   * cluster".
   */
  seenCluster: (context: string, identity: string | null) => void;
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
      identities: {},
      seenCluster: (context, identity) => {
        if (identity === null) return;
        const known = get().identities[context];
        set((state) =>
          known === identity
            ? state
            : {
                entries:
                  known === undefined
                    ? state.entries
                    : state.entries.filter((e) => e.context !== context),
                spans:
                  known === undefined
                    ? state.spans
                    : Object.fromEntries(
                        Object.entries(state.spans).filter(
                          ([key]) => key !== context
                        )
                      ),
                identities: { ...state.identities, [context]: identity },
              }
        );
      },
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
              ...pruned(
                (state.spans[context] ?? []).map((span) =>
                  span.to === null ? { ...span, to: span.seenAt } : span
                ),
                now
              ),
              { from: now, seenAt: now, to: null },
            ],
          },
        })),
      heartbeat: (context, now) => {
        const list = get().spans[context] ?? [];
        const open = list.findIndex((span) => span.to === null);
        if (open === -1) return;
        // A tick this late means the timer did not run. The stretch since the
        // last one was not watched, so the span ends there and a new one
        // starts here, leaving a gap between them.
        const missed = now - list[open].seenAt > HEARTBEAT_MISSED_MS;
        set((state) => ({
          spans: {
            ...state.spans,
            [context]: (state.spans[context] ?? []).flatMap((span, index) => {
              if (index !== open) return [span];
              if (!missed) return [{ ...span, seenAt: now }];
              return [
                { ...span, to: span.seenAt },
                { from: now, seenAt: now, to: null },
              ];
            }),
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
          identities: Object.fromEntries(
            Object.entries(state.identities).filter(([key]) => key !== context)
          ),
        })),
    }),
    {
      name: "change-journal",
      version: 1,
      storage: createJSONStorage(batchedStorage),
      partialize: (state) => ({
        entries: state.entries,
        spans: state.spans,
        identities: state.identities,
      }),
      // Whatever was open when the app closed did not keep watching after
      // it: the stretch since is a gap, not a quiet cluster.
      migrate: (persisted) => {
        const stored = (persisted ?? {}) as Partial<ChangeJournalState>;
        return {
          entries: Array.isArray(stored.entries) ? stored.entries : [],
          spans: closed(stored.spans ?? {}),
          identities: stored.identities ?? {},
        } as ChangeJournalState;
      },
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<ChangeJournalState>;
        return {
          ...current,
          entries: Array.isArray(stored.entries) ? stored.entries : [],
          spans: closed(stored.spans ?? {}),
          identities: stored.identities ?? {},
        };
      },
    }
  )
);
