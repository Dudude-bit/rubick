/**
 * What the reader says a cluster's resources cost, per context name: the
 * Cost page's second source, where no Prometheus prices the cluster.
 *
 * Kept on this machine like a cluster's colour or name, not in the
 * kubeconfig and not in `config.toml`: nothing secret, and nothing a
 * rollback has to read. Let go when the name turns into another cluster.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistedByName } from "@/lib/kept-by-name";
import type { Prices } from "@/lib/cost";
import {
  entriesOf,
  entryOf,
  named,
  withEntry,
  withoutEntry,
  type Named,
} from "@/lib/named";

interface CostPricesState {
  prices: Named<Prices>;
  setPrices: (context: string, prices: Prices | null) => void;
}

const isPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A stored entry, checked rather than trusted; `null` where it is not one. */
export function pricesOf(raw: unknown): Prices | null {
  const entry = raw as Partial<Prices> | null | undefined;
  if (!entry || !isPrice(entry.cpu) || !isPrice(entry.memory)) return null;
  return {
    cpu: entry.cpu,
    memory: entry.memory,
    storage: isPrice(entry.storage) ? entry.storage : null,
    gpu: isPrice(entry.gpu) ? entry.gpu : null,
    currency: typeof entry.currency === "string" ? entry.currency.trim() : "",
  };
}

/** What a stored state holds that is a cluster's prices; the rest is dropped. */
function validPrices(persisted: unknown): Named<Prices> {
  const stored = (persisted as { prices?: unknown } | undefined)?.prices;
  if (!stored || typeof stored !== "object") return named();
  return named(
    entriesOf(named<unknown>(stored as Record<string, unknown>)).flatMap(
      ([context, raw]): [string, Prices][] => {
        const valid = pricesOf(raw);
        return valid ? [[context, valid]] : [];
      }
    )
  );
}

export const useCostPricesStore = create<CostPricesState>()(
  persist(
    (set) => ({
      prices: named(),
      setPrices: (context, prices) =>
        set((state) => {
          const valid = prices && pricesOf(prices);
          return {
            prices: valid
              ? withEntry(state.prices, context, valid)
              : withoutEntry(state.prices, context),
          };
        }),
    }),
    {
      name: "cost-prices",
      version: 1,
      // Every restore, not only one from another version: `migrate` runs
      // only where the stored version differs, and what is stored is read
      // back as it lies on the disk.
      merge: (persisted, current) => ({
        ...current,
        prices: validPrices(persisted),
      }),
      migrate: (persisted) =>
        ({ prices: validPrices(persisted) }) as CostPricesState,
    }
  )
);

// Another cluster's prices are not this one's.
persistedByName((context) =>
  useCostPricesStore.setState((state) => ({
    prices: withoutEntry(state.prices, context),
  }))
);

/** One cluster's prices, or `null` where none were entered. */
export function useCostPrices(
  context: string | null | undefined
): Prices | null {
  return useCostPricesStore((s) =>
    context ? (entryOf(s.prices, context) ?? null) : null
  );
}
