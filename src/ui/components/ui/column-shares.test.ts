import { describe, expect, it } from "vite-plus/test";

import { columnShares } from "./column-shares";

describe("columnShares", () => {
  /** Fails if an unmeasured table stops falling back to its declared proportions. */
  it("splits by size until the table has a width", () => {
    expect(columnShares([{ size: 300 }, { size: 100, floor: 200 }], 0)).toEqual(
      [75, 25]
    );
  });

  /**
   * The Pods list gave its IP column 101px of a 1160px table and cut every
   * address to "192.168...". Fails if a floor stops pinning a column the
   * proportional split draws too narrow, or if the others stop sharing what
   * is left by their sizes.
   */
  it("pins a column at its floor and shares the rest by size", () => {
    const [name, ip, age] = columnShares(
      [{ size: 300 }, { size: 100, floor: 400 }, { size: 100 }],
      1000
    );
    expect(ip).toBeCloseTo(40);
    expect(name).toBeCloseTo(45);
    expect(age).toBeCloseTo(15);
  });

  /** Fails if a floor the split already clears starts bending the proportions. */
  it("leaves the proportions alone when every floor is already met", () => {
    expect(
      columnShares([{ size: 100, floor: 50 }, { size: 100 }], 400)
    ).toEqual([50, 50]);
  });
});
