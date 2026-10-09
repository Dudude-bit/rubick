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
      [
        { size: 300, floor: 600 },
        { size: 100, floor: 300 },
        { size: 100, floor: 200 },
      ],
      800
    );
    expect(layout.span).toBe(1100);
    expect(layout.scrolls).toBe(true);
    expect((layout.shares[0] / 100) * 1100).toBeCloseTo(600);
    expect((layout.shares[1] / 100) * 1100).toBeCloseTo(300);
    expect((layout.shares[2] / 100) * 1100).toBeCloseTo(200);
  });

  /**
   * Scrolled to the end, Lena's Pods showed a stray ")" of a restart count
   * beside the pinned Name, and Dana's Events "a…" of a message beside the
   * pinned Reason. Fails if the columns that end the table stop taking a
   * sliver's width so the column before them is wholly under the pinned one,
   * or if the row's buttons take any of it.
   */
  it("ends a sideways scroll on whole columns, not a sliver of one", () => {
    const layout = tableLayout(
      [
        { size: 300, floor: 280 },
        { size: 140, floor: 136 },
        { size: 170, floor: 204 },
        { size: 80, floor: 62 },
        { size: 122, floor: 122, fixed: true },
      ],
      674
    );
    const px = layout.shares.map((share) => (share / 100) * layout.span);
    expect(layout.scrolls).toBe(true);
    expect(px[2] + px[3] + px[4]).toBeCloseTo(674 - 280);
    expect(px[1]).toBeCloseTo(136);
    expect(px[4]).toBeCloseTo(122);
    expect(px[2] + px[3]).toBeCloseTo(204 + 62 + 6);
  });

  /** Fails if a column that shows enough of itself to read at the end is pushed under the pinned one by widening the last ones past use. */
  it("leaves a column that shows more than a sliver where it is", () => {
    const layout = tableLayout(
      [
        { size: 300, floor: 280 },
        { size: 140, floor: 136 },
        { size: 170, floor: 204 },
        { size: 80, floor: 62 },
        { size: 122, floor: 122, fixed: true },
      ],
      660
    );
    expect(layout.span).toBe(280 + 136 + 204 + 62 + 122);
  });

  /** Fails if a table nobody has measured yet is called scrolling, and widened to its floors, before it has a port. */
  it("does not scroll before the port is measured", () => {
    const layout = tableLayout([{ size: 100, floor: 900 }], 0);
    expect(layout.scrolls).toBe(false);
    expect(layout.span).toBe(0);
  });

  /** Fails if a column stops keeping its ideal width while every column's fits the port. */
  it("keeps a column at its ideal while the port has room for every ideal", () => {
    const layout = tableLayout(
      [
        { size: 100, floor: 100, ideal: 300 },
        { size: 400, floor: 100 },
      ],
      600
    );
    expect((layout.shares[0] / 100) * layout.span).toBeCloseTo(300);
  });

  /**
   * With a peek open the Events table had 296px, and a reason held at its
   * one-line width left the Object column three letters. Fails if a port too
   * narrow for every ideal stops falling back to the floors.
   */
  it("falls back to the floors once the ideals outgrow the port", () => {
    const layout = tableLayout(
      [
        { size: 100, floor: 100, ideal: 300 },
        { size: 100, floor: 250 },
      ],
      400
    );
    expect(layout.scrolls).toBe(false);
    expect((layout.shares[1] / 100) * layout.span).toBeCloseTo(250);
    expect((layout.shares[0] / 100) * layout.span).toBeCloseTo(150);
  });
});
