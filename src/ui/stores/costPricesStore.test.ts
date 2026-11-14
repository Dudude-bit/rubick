import { describe, expect, it } from "vite-plus/test";

import { nameIsAnotherCluster } from "@/lib/kept-by-name";
import { pricesOf, useCostPricesStore } from "./costPricesStore";

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
});
