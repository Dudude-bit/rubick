import { describe, expect, it } from "vitest";

import { troubleMark } from "./kit";

const says = (n: number, total: number) => `${n}/${total}`;

describe("the mark on a tab listing things that can be broken", () => {
  /** An empty tab with a "0" on it reads as a count that was taken. */
  it("marks nothing when there is nothing listed", () => {
    expect(troubleMark([], says)).toBeUndefined();
  });

  /** All well is a count, not a colour. */
  it("counts the rows when none is in trouble", () => {
    expect(troubleMark([null, undefined, null], says)).toEqual({
      shows: "count",
      of: 3,
    });
  });

  /** One broken row among warnings paints the tab red, and counts both. */
  it("takes the worst tone and counts every troubled row", () => {
    expect(troubleMark(["warn", null, "err", "warn"], says)).toEqual({
      shows: "severity",
      tone: "err",
      says: "3/4",
    });
  });

  it("stays amber when nothing is broken", () => {
    expect(troubleMark(["warn", null], says)).toEqual({
      shows: "severity",
      tone: "warn",
      says: "1/2",
    });
  });

  /**
   * Hosts whose backends were unread wore a plain count — the page's third
   * state collapsing into its second on the tab strip.
   */
  it("says rows went unchecked rather than counting them", () => {
    expect(troubleMark(["unknown", null], says, says)).toEqual({
      shows: "unchecked",
      says: "1/2",
    });
  });

  /** A real finding still outranks a row nobody could check. */
  it("lets a finding win over an unchecked row", () => {
    expect(troubleMark(["unknown", "warn"], says, says)).toEqual({
      shows: "severity",
      tone: "warn",
      says: "1/2",
    });
  });
});
