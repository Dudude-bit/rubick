import { describe, expect, it } from "vite-plus/test";

import { allocatedPercent, nodeQuantities } from "./node-amount";

describe("a node's CPU figures", () => {
  /** The page wrote a CPU row holding a whole core in cores and the peek wrote it in millicores; fails if the two stop sharing the rule. */
  it("are written in cores across a row that holds a whole core", () => {
    expect(nodeQuantities("cpu", ["2", "1950m"])).toEqual(["2", "1.95"]);
  });

  /** A row under one core keeps millicores; fails if every CPU figure turns into cores. */
  it("keep millicores across a row under one core", () => {
    expect(nodeQuantities("cpu", ["500m", "450m"])).toEqual(["500m", "450m"]);
  });
});

describe("a node's share of what it can give", () => {
  /**
   * Lena read 15.6% as 15%, and before that a 1.6% limit as 2% where kubectl
   * describe node says 1%. Fails if the tenth is dropped, or rounding it
   * carries the whole number past the one kubectl prints.
   */
  it("keeps a tenth and the whole number kubectl prints", () => {
    expect(allocatedPercent(654, 4194, "en")).toBe("15.6");
    expect(allocatedPercent(32, 2048, "en")).toBe("1.6");
    expect(allocatedPercent(3096, 10000, "en")).toBe("30.9");
    expect(allocatedPercent(465, 1000, "ru")).toBe("46,5");
    expect(allocatedPercent(55, 110, "en")).toBe("50");
    expect(allocatedPercent(1, 0, "en")).toBeNull();
  });
});
