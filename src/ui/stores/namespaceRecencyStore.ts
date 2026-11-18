import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistedByName } from "@/lib/kept-by-name";
import {
  type Named,
  entryOf,
  named,
  storedEntries,
  withEntry,
  withoutEntry,
} from "@/lib/named";

const KEEP = 6;

interface NamespaceRecencyState {
  /** Context name to the namespaces last scoped to there, newest first. */
  recent: Named<string[]>;
  record: (context: string, namespaces: readonly string[]) => void;
}

export const useNamespaceRecencyStore = create<NamespaceRecencyState>()(
  persist(
    (set) => ({
      recent: named(),
      record: (context, namespaces) => {
        if (namespaces.length === 0) return;
        set((state) => ({
          recent: withEntry(
            state.recent,
            context,
            [
              ...new Set([
                ...namespaces,
                ...(entryOf(state.recent, context) ?? []),
              ]),
            ].slice(0, KEEP)
          ),
        }));
      },
    }),
    {
      name: "namespace-recency",
      version: 1,
      migrate: (persisted) => {
        const stored = (persisted as { recent?: unknown } | undefined)?.recent;
        const recent = named(
          storedEntries(stored)
            .filter((entry): entry is [string, unknown[]] =>
              Array.isArray(entry[1])
            )
            .map(([context, names]): [string, string[]] => [
              context,
              names
                .filter((name): name is string => typeof name === "string")
                .slice(0, KEEP),
            ])
        );
        return { recent } as NamespaceRecencyState;
      },
    }
  )
);

// The namespaces offered first are the last cluster's under this name.
persistedByName((context) =>
  useNamespaceRecencyStore.setState((state) => ({
    recent: withoutEntry(state.recent, context),
  }))
);
