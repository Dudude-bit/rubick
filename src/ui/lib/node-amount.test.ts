import { describe, expect, it } from "vite-plus/test";

import { nodeQuantities } from "./node-amount";

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
