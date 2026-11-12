import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { LogLegend } from "./LogLegend";

describe("a lane's chip", () => {
  /**
   * Seen live: a chip read 626 beside a footer holding 313 lines, and
   * nothing said what the chip's number was of. Fails if the number stops
   * saying it counts the lane's lines held here.
   */
  it("says its number is the lines of that lane held here", () => {
    render(
      <LogLegend
        entries={[{ key: "db-0", label: "db-0" }]}
        colors={new Map()}
        counts={new Map([["db-0", 313]])}
        hidden={new Set()}
        onToggle={() => {}}
        onSolo={() => {}}
        onShowAll={() => {}}
      />
    );
    expect(screen.getByText("313")).toHaveAttribute(
      "title",
      "313 lines from db-0 are held here"
    );
  });
});
