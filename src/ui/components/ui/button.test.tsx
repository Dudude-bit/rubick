import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "@/components/ui/button";

describe("a disabled button", () => {
  /**
   * An enabled Delete was a shade stronger than a disabled one because the
   * disabled look was the enabled red at half strength. Fails if a disabled
   * destructive button keeps the error hue, or loses its dimming and inertness.
   */
  it("drops the error hue and is dimmed and inert", () => {
    render(
      <Button variant="destructive" disabled>
        Delete
      </Button>
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toBeDisabled();
    expect(button).toHaveClass(
      "disabled:bg-sel",
      "disabled:text-fg-fnt",
      "disabled:opacity-50",
      "disabled:pointer-events-none"
    );
  });

  /** Fails if a button drawn through `asChild` with `aria-disabled` stays clickable and undimmed. */
  it("is dimmed and inert when only aria-disabled", () => {
    render(
      <Button asChild>
        <a aria-disabled="true">Open</a>
      </Button>
    );
    expect(screen.getByText("Open")).toHaveClass(
      "aria-disabled:opacity-50",
      "aria-disabled:pointer-events-none"
    );
  });
});
