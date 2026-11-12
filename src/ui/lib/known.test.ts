import { describe, expect, it } from "vite-plus/test";

import { knownOf } from "./known";

describe("a read with no answer", () => {
  /**
   * Not checked draws a refusal under a lock and a failure under a triangle,
   * and reads which it was from here. Fails if the failure's code is dropped,
   * or a read still on its way is given one.
   */
  it("keeps the code its failure came with, and none while it is reading", () => {
    const refusal = Object.assign(new Error("ingressclasses is forbidden"), {
      code: "PERMISSION_DENIED",
    });
    expect(knownOf({ data: undefined, error: refusal })).toEqual({
      known: false,
      why: "ingressclasses is forbidden",
      code: "PERMISSION_DENIED",
    });
    expect(knownOf({ data: undefined, error: null })).toEqual({
      known: false,
      why: null,
    });
    expect(knownOf({ data: 0, error: refusal })).toEqual({
      known: true,
      value: 0,
    });
  });
});
