import { describe, expect, it } from "vitest";

import { criticalityOf } from "./critical";

describe("criticalityOf", () => {
  /** A guard armed by a name alone fires on `product-catalog-dev` and is switched off for good. */
  it("guesses from the name but never arms the guard on a guess", () => {
    expect(criticalityOf("prod-eu-1", undefined)).toEqual({
      critical: false,
      guessed: true,
    });
    expect(criticalityOf("staging", undefined)).toEqual({
      critical: false,
      guessed: false,
    });
  });

  /** Once the person has said, the name stops mattering either way. */
  it("takes the person's word over the name", () => {
    expect(criticalityOf("prod-eu-1", { critical: false })).toEqual({
      critical: false,
      guessed: false,
    });
    expect(criticalityOf("sandbox", { critical: true })).toEqual({
      critical: true,
      guessed: false,
    });
    expect(criticalityOf(null, { critical: true }).critical).toBe(false);
  });
});
