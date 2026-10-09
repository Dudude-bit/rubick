import { describe, expect, it } from "vite-plus/test";

import { formatCount } from "./count";

describe("formatCount", () => {
  /** Would break if a long count lost its group space, or a short one gained one. */
  it("groups the thousands with a narrow no-break space", () => {
    expect(formatCount(2481)).toBe("2 481");
    expect(formatCount(12)).toBe("12");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234567)).toBe("1 234 567");
  });
});
