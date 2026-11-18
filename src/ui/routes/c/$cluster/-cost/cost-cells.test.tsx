import { screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { renderWithProviders } from "@/test/render";
import { Money, ShareCell } from "./cost-cells";

const row = { perHour: 0.05, unpriced: [], unknown: [] };

describe("a cell that says something other than a number", () => {
  /**
   * A share with no whole to take it of, and an amount nobody could read,
   * were drawn like a figure and like "not priced". Fails if either takes
   * the tone of the other or of a number.
   */
  it("is toned by what it says", () => {
    renderWithProviders(
      <>
        <ShareCell row={{ ...row, share: { of: 0.25, bound: "exact" } }} />
        <ShareCell row={{ ...row, share: "noTotal" }} />
        <ShareCell row={{ ...row, share: "bothFloors" }} />
        <ShareCell row={{ perHour: null, unknown: ["storage"], share: null }} />
        <ShareCell row={{ perHour: null, unknown: [], share: null }} />
        <Money value="notKnown" currency="" />
        <Money value="notPriced" currency="" />
      </>
    );
    expect(screen.getByText("25%")).toHaveClass("font-mono");
    expect(screen.getByText("not known: no total")).toHaveClass("text-fg-mut");
    expect(screen.getByText("not known: both are floors")).toHaveClass(
      "text-fg-mut"
    );
    const [unknownShare, unknownTotal] = screen.getAllByText("Not known");
    expect(unknownShare).toHaveClass("text-warn");
    expect(unknownTotal).toHaveClass("text-warn");
    for (const quiet of screen.getAllByText("not priced"))
      expect(quiet).toHaveClass("text-fg-fnt");
  });
});
