import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  isOpen,
  MAX_WATCHES_PER_CLUSTER,
  WATCH_TTL_MS,
  type Baseline,
  type Watch,
  type WatchStatus,
} from "@/lib/tell-me-when";

export type AddOutcome = "added" | "already" | "full";

interface TellMeWhenState {
  watches: Watch[];
  /**
   * Refuses past the cap rather than quietly dropping the oldest: which one
   * to give up is the person's call, and the panel asks them.
   */
  add: (watch: Watch) => AddOutcome;
  /** Drop one to make room, then add. */
  replace: (dropId: string, watch: Watch) => void;
  remove: (id: string) => void;
  setStatus: (id: string, status: WatchStatus) => void;
  setBaseline: (id: string, baseline: Baseline) => void;
  /** Ages every open watch against the clock; returns how many expired. */
  expire: (now: number) => number;
}

export const useTellMeWhenStore = create<TellMeWhenState>()(
  persist(
    (set, get) => ({
      watches: [],
      add: (watch) => {
        const open = get().watches.filter(
          (w) => w.context === watch.context && isOpen(w)
        );
        if (
          open.some(
            (w) =>
              w.kind === watch.kind &&
              w.namespace === watch.namespace &&
              w.name === watch.name &&
              w.sessionId === watch.sessionId
          )
        ) {
          return "already";
        }
        if (open.length >= MAX_WATCHES_PER_CLUSTER) return "full";
        set((state) => ({ watches: [...state.watches, watch] }));
        return "added";
      },
      replace: (dropId, watch) =>
        set((state) => ({
          watches: [...state.watches.filter((w) => w.id !== dropId), watch],
        })),
      remove: (id) =>
        set((state) => ({
          watches: state.watches.filter((w) => w.id !== id),
        })),
      setStatus: (id, status) =>
        set((state) => ({
          watches: state.watches.map((w) =>
            w.id === id ? { ...w, status } : w
          ),
        })),
      setBaseline: (id, baseline) =>
        set((state) => ({
          watches: state.watches.map((w) =>
            w.id === id ? { ...w, baseline } : w
          ),
        })),
      expire: (now) => {
        let expired = 0;
        const watches = get().watches.map((w) => {
          if (!isOpen(w) || now - w.startedAt < WATCH_TTL_MS) return w;
          expired += 1;
          return { ...w, status: { state: "expired" } as const };
        });
        if (expired > 0) set({ watches });
        return expired;
      },
    }),
    {
      name: "tell-me-when",
      version: 1,
      // A watch is only ever open or answered; whatever a stream had
      // established before the app closed is gone with the stream, so an
      // open one comes back with nothing remembered and starts looking again.
      migrate: (persisted) => {
        const stored = (persisted as { watches?: unknown } | undefined)
          ?.watches;
        const watches = Array.isArray(stored)
          ? (stored as Watch[]).filter(
              (w) =>
                typeof w?.id === "string" &&
                typeof w.context === "string" &&
                typeof w.name === "string"
            )
          : [];
        return {
          watches: watches.map((w) =>
            isOpen(w) ? { ...w, baseline: null } : w
          ),
        } as TellMeWhenState;
      },
    }
  )
);

const EMPTY: Watch[] = [];

export function useWatchesFor(context: string | null): Watch[] {
  return useTellMeWhenStore((s) =>
    context === null ? EMPTY : s.watches
  ).filter((w) => w.context === context);
}
