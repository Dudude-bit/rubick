import { describe, expect, it } from "vite-plus/test";

import { columnShares, tableLayout } from "./column-shares";

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

describe("tableLayout", () => {
  /** Fails if a table whose floors fit starts asking for more than its port, which is a scrollbar nobody needs. */
  it("is as wide as the port while the floors fit", () => {
    const layout = tableLayout(
      [
        { size: 300, floor: 200 },
        { size: 100, floor: 100 },
      ],
      1000
    );
    expect(layout.span).toBe(1000);
    expect(layout.scrolls).toBe(false);
    expect(layout.shares).toEqual([75, 25]);
  });

  /**
   * Per cent of a table no wider than its port cut a column under its floor
   * without a scrollbar to show for it. Fails if floors that outgrow the port
   * stop widening the table to their sum, with every column at its floor.
   */
  it("is as wide as the floors when they outgrow the port", () => {
    const layout = tableLayout(
      [{ size: 300, floor: 600 }, { size: 100, floor: 300 }, { size: 100 }],
      800
    );
    expect(layout.span).toBe(900);
    expect(layout.scrolls).toBe(true);
    expect((layout.shares[0] / 100) * 900).toBeCloseTo(600);
    expect((layout.shares[1] / 100) * 900).toBeCloseTo(300);
    expect(layout.shares[2]).toBe(0);
  });

  /** Fails if a table nobody has measured yet is called scrolling, and widened to its floors, before it has a port. */
  it("does not scroll before the port is measured", () => {
    const layout = tableLayout([{ size: 100, floor: 900 }], 0);
    expect(layout.scrolls).toBe(false);
    expect(layout.span).toBe(0);
  });
});
