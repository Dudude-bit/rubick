import { create } from "zustand";
import { persist } from "zustand/middleware";

const KEEP = 6;

interface NamespaceRecencyState {
  /** Context name to the namespaces last scoped to there, newest first. */
  recent: Record<string, string[]>;
  record: (context: string, namespaces: readonly string[]) => void;
}

export const useNamespaceRecencyStore = create<NamespaceRecencyState>()(
  persist(
    (set) => ({
      recent: {},
      record: (context, namespaces) => {
        if (namespaces.length === 0) return;
        set((state) => ({
          recent: {
            ...state.recent,
            [context]: [
              ...new Set([...namespaces, ...(state.recent[context] ?? [])]),
            ].slice(0, KEEP),
          },
        }));
      },
    }),
    {
      name: "namespace-recency",
      version: 1,
      migrate: (persisted) => {
        const stored = (persisted as { recent?: unknown } | undefined)?.recent;
        const recent: Record<string, string[]> = {};
        if (stored && typeof stored === "object") {
          for (const [context, names] of Object.entries(stored)) {
            if (Array.isArray(names))
              recent[context] = names
                .filter((name) => typeof name === "string")
                .slice(0, KEEP);
          }
        }
        return { recent } as NamespaceRecencyState;
      },
    }
  )
);
