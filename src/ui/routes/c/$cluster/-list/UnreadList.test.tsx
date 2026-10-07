import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { UnreadList } from "./UnreadList";

describe("a list nobody could read", () => {
  /**
   * Under a metrics banner on Pods the refusal sat ~80px below it: the page
   * column's gap, the banner's margin and this block's own top padding all
   * stacked. The column and the banner already space it, so it adds none.
   * Fails if a top padding comes back.
   */
  it("adds no space of its own above the words", () => {
    render(<UnreadList error={new Error("forbidden")} words="Refused" />);
    const block = screen.getByTestId("unread-list");
    expect(block.className).not.toMatch(/\bp[ty]-\d/);
    expect(block).toHaveClass("pb-8");
  });
});
