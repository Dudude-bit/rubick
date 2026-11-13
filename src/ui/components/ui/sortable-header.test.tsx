import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { Button } from "./button";
import { SortableHeader } from "./sortable-header";

const column = { getIsSorted: () => false as const, toggleSorting: () => {} };

describe("a sortable column header", () => {
  /**
   * Focus on a header was a faint grey fill while every other control drew
   * the blue ring, so a keyboard reader lost their place in the table. Fails
   * if the header's focus look stops being the ring a button draws.
   */
  it("draws the ring every other control draws when focused from the keyboard", () => {
    render(
      <>
        <SortableHeader column={column} k="name" />
        <Button>Share</Button>
      </>
    );
    const header = screen.getByRole("button", { name: /^Name/ });
    const ring = ["focus-visible:ring-1", "focus-visible:ring-info"];
    expect(screen.getByRole("button", { name: "Share" })).toHaveClass(...ring);
    expect(header).toHaveClass(...ring);
    expect(header).not.toHaveClass("focus-visible:bg-hover");
  });
});
