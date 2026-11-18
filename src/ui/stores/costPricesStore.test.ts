// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { nameIsAnotherCluster } from "@/lib/kept-by-name";
import { renderHook } from "@testing-library/react";

import { pricesOf, useCostPrices, useCostPricesStore } from "./costPricesStore";

const prices = {
  cpu: 0.04,
  memory: 0.005,
  storage: 0.1,
  gpu: null,
  currency: "USD",
};

describe("entered prices", () => {
  /** A stored entry is checked, not trusted: a broken one is no prices, not zero. */
  it("refuses a stored entry without a CPU or memory price", () => {
    expect(pricesOf({ ...prices, cpu: "free" })).toBeNull();
    expect(pricesOf({ ...prices, memory: -1 })).toBeNull();
    expect(pricesOf({ ...prices, storage: "x" })).toEqual({
      ...prices,
      storage: null,
    });
  });

  /** Another cluster behind the same name is not priced like the last one. */
  it("forgets a cluster's prices when its name turns into another cluster", () => {
    useCostPricesStore.getState().setPrices("prod", prices);
    useCostPricesStore.getState().setPrices("dev", prices);
    nameIsAnotherCluster("prod");
    expect(useCostPricesStore.getState().prices).toEqual({ dev: prices });
  });

  /**
   * `migrate` runs only where the stored version differs, so a stored
   * entry of this version came back unchecked: a negative CPU price stood
   * in the dialog and the estimate. Fails if a restore of the same version
   * trusts what it reads.
   */
  it("checks every entry when it restores, at its own version too", async () => {
    localStorage.setItem(
      "cost-prices",
      JSON.stringify({
        state: { prices: { prod: { ...prices, cpu: -1 }, dev: prices } },
        version: 1,
      })
    );
    await useCostPricesStore.persist.rehydrate();
    expect(useCostPricesStore.getState().prices).toEqual({ dev: prices });
  });

  /**
   * A context name is the reader's to choose, and `constructor` read an
   * inherited function as its prices. Fails if a name finds a property.
   */
  it("has no prices for a context nobody priced, whatever its name", () => {
    useCostPricesStore.setState({ prices: {} });
    const { result } = renderHook(() => useCostPrices("constructor"));
    expect(result.current).toBeNull();
  });
});
