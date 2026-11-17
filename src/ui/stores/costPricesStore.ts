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

interface CostPricesState {
  prices: Record<string, Prices>;
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
function validPrices(persisted: unknown): Record<string, Prices> {
  const stored = (persisted as { prices?: unknown } | undefined)?.prices;
  const prices: Record<string, Prices> = {};
  if (stored && typeof stored === "object")
    for (const [context, raw] of Object.entries(stored)) {
      const valid = pricesOf(raw);
      if (valid) prices[context] = valid;
    }
  return prices;
}

export const useCostPricesStore = create<CostPricesState>()(
  persist(
    (set) => ({
      prices: {},
      setPrices: (context, prices) =>
        set((state) => {
          const next = { ...state.prices };
          const valid = prices && pricesOf(prices);
          if (valid) next[context] = valid;
          else delete next[context];
          return { prices: next };
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
    prices: Object.fromEntries(
      Object.entries(state.prices).filter(([name]) => name !== context)
    ),
  }))
);

/** One cluster's prices, or `null` where none were entered. */
export function useCostPrices(
  context: string | null | undefined
): Prices | null {
  // A context name is the reader's: `constructor` must not find a property.
  return useCostPricesStore((s) =>
    context && Object.hasOwn(s.prices, context) ? s.prices[context]! : null
  );
}
