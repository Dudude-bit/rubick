import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { DropdownMenuItem } from "./dropdown-menu";
import { PointMenu } from "./point-menu";

describe("a menu opened at a point", () => {
  /**
   * Lena's row menu in Russian held fourteen items, stopped at 24rem and hid
   * Delete under a scroll with 90 px of window free below it. Fails if the
   * menu is held under the room the window gives it.
   */
  it("is bounded by the room the window gives it, not by a fixed height", () => {
    render(
      <PointMenu x={10} y={10} onClose={vi.fn()}>
        <DropdownMenuItem>Delete</DropdownMenuItem>
      </PointMenu>
    );
    const menu = screen.getByRole("menu");
    expect(menu).toHaveClass(
      "max-h-(--radix-dropdown-menu-content-available-height)"
    );
    expect(menu.className).not.toContain("24rem");
  });
});
