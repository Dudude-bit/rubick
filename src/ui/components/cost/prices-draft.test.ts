import { describe, expect, it } from "vite-plus/test";

import { pricesFromDraft } from "./prices-draft";

const draft = (over: Partial<Record<string, string>> = {}) => ({
  cpu: "0.04",
  memory: "0.005",
  storage: "",
  gpu: "",
  currency: " EUR ",
  ...over,
});

describe("prices from the form", () => {
  /** An empty optional field leaves its resource unpriced, never free. */
  it("reads an empty optional price as not entered, not as zero", () => {
    expect(pricesFromDraft(draft()).prices).toEqual({
      cpu: 0.04,
      memory: 0.005,
      storage: null,
      gpu: null,
      currency: "EUR",
    });
  });

  it("takes a decimal comma, as a Russian keyboard writes one", () => {
    expect(pricesFromDraft(draft({ storage: "0,1" })).prices?.storage).toBe(
      0.1
    );
  });

  /** CPU and memory are what the estimate stands on; without them there is none. */
  it("refuses a draft without CPU or memory, and one with a negative price", () => {
    expect(pricesFromDraft(draft({ cpu: "" })).wrong).toEqual(["cpu"]);
    expect(pricesFromDraft(draft({ memory: "-1", gpu: "x" })).wrong).toEqual([
      "memory",
      "gpu",
    ]);
  });
});
